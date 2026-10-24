import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import { migrate, query, one, closeDb } from './db.js';
import { requireAuth, requireWorkspace } from './auth.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import workspaceRoutes from './routes/workspace.js';
import trackRoutes from './routes/track.js';
import v1Routes from './routes/v1.js';
import webhookRoutes from './routes/webhooks.js';
import formRoutes from './routes/forms.js';
import { publicMedia } from './routes/media.js';
import { startWorker } from './queue.js';
import ssoRoutes from './routes/sso.js';
import scimRoutes from './routes/scim.js';

const app = express();
app.set('trust proxy', 1);

// Every request gets an id (returned as X-Request-Id) and one structured log line. Headers, bodies and
// query strings are never logged, so tokens, passwords and card numbers cannot leak into the logs.
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  const started = Date.now();
  res.on('finish', () => {
    if (req.path === '/health' || req.path === '/health/ready') return;
    console.log(JSON.stringify({ level: res.statusCode >= 500 ? 'error' : 'info', msg: 'request', id: req.id, method: req.method,
      path: req.originalUrl.split('?')[0].replace(/^\/(t|m|f)\/.*/, '/$1/:x').replace(/\/\d+/g, '/:n'), status: res.statusCode, ms: Date.now() - started }));
  });
  next();
});
// The tracking pixel is embedded by mail clients, so it must be loadable cross-origin.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use('/webhooks', webhookRoutes);
app.use('/scim/v2', scimRoutes);
app.use('/sso', ssoRoutes);
app.use(express.json({ limit: '2mb' }));

const origins = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',').map((s) => s.trim().replace(/\/+$/, ''));
const apiCors = cors({ origin: origins });

app.get('/health', (_req, res) => res.json({ ok: true, service: 'wynmail' }));
// Readiness: also proves the database answers. Point an uptime monitor at this one.
app.get('/health/ready', async (_req, res) => {
  try { await one('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});
// Where a stranger should send a vulnerability report (RFC 9116). Set SECURITY_CONTACT to an email or URL.
app.get('/.well-known/security.txt', (_req, res) => {
  const contact = process.env.SECURITY_CONTACT;
  if (!contact) return res.status(404).type('text/plain').send('Not found');
  const to = /^[\w.+-]+@[\w.-]+$/.test(contact) ? `mailto:${contact}` : contact;
  res.type('text/plain').send(`Contact: ${to}\nExpires: ${new Date(Date.now() + 365 * 86400000).toISOString()}\nPreferred-Languages: en\n`);
});
app.use('/t', trackRoutes);
app.use(formRoutes);
app.use(publicMedia);
app.use('/v1', v1Routes);
app.use('/api', apiCors);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/workspaces/:workspaceId', requireAuth, requireWorkspace, workspaceRoutes);

app.use((err, _req, res, _next) => {
  if (err.code === '22P02') return res.status(400).json({ error: 'bad request' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large. Pictures can be up to 3 MB.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: 'bad request' });
  console.error(err);
  res.status(500).json({ error: 'server error' });
});

const port = Number(process.env.PORT || 4000);
await migrate();

// Hourly clean-up of data we no longer need. Every statement is idempotent, so two servers running it is harmless.
const AUDIT_DAYS = Number(process.env.AUDIT_RETENTION_DAYS || 400);
const EVENT_DAYS = Number(process.env.EVENTS_RETENTION_DAYS || 0); // 0 keeps events forever
const housekeeping = async () => {
  const run = (sql, params) => query(sql, params).catch((err) => console.error(JSON.stringify({ level: 'error', msg: 'housekeeping failed', err: err.message })));
  // Unconfirmed signups are personal data we no longer need after their link expires plus 30 days.
  await run(`DELETE FROM form_signups WHERE confirmed_at IS NULL AND expires_at < now() - interval '30 days'`);
  await run(`DELETE FROM password_resets WHERE expires_at < now() - interval '7 days' OR used_at < now() - interval '7 days'`);
  await run(`DELETE FROM saml_requests WHERE created_at < now() - interval '1 hour'`);
  await run(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`);
  // Signup logs of contacts whose undo window ended go with them (unless the address was added again).
  await run(`DELETE FROM form_signups fs USING deleted_records d WHERE d.kind = 'contact' AND d.purge_after < now() AND fs.workspace_id = d.workspace_id
    AND fs.email = d.data->'row'->>'email' AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.workspace_id = fs.workspace_id AND c.email = fs.email)`);
  await run(`DELETE FROM deleted_records WHERE purge_after < now()`);
  await run(`DELETE FROM audit_log WHERE created_at < now() - ($1 || ' days')::interval`, [String(AUDIT_DAYS)]);
  if (EVENT_DAYS > 0) await run(`DELETE FROM events WHERE created_at < now() - ($1 || ' days')::interval`, [String(EVENT_DAYS)]);
};
housekeeping();
const hk = setInterval(housekeeping, 3600000);
hk.unref();

const worker = process.env.RUN_WORKER !== '0' ? startWorker() : null;
const server = app.listen(port, () => console.log(JSON.stringify({ level: 'info', msg: 'listening', port })));

// Render sends SIGTERM on every deploy. Stop taking new work, let in-flight requests finish, then exit,
// so a deploy never cuts a request in half. The queue recovers any message claimed but not finished.
let stopping = false;
const shutdown = (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
  if (worker) clearInterval(worker);
  clearInterval(hk);
  server.close(async () => { await closeDb().catch(() => {}); process.exit(0); });
  setTimeout(() => process.exit(1), 25000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error(JSON.stringify({ level: 'error', msg: 'unhandledRejection', err: String(err?.message || err) })));
