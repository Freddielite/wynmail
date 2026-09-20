import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { migrate, query } from './db.js';
import { requireAuth, requireWorkspace } from './auth.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import workspaceRoutes from './routes/workspace.js';
import trackRoutes from './routes/track.js';
import v1Routes from './routes/v1.js';
import webhookRoutes from './routes/webhooks.js';
import formRoutes from './routes/forms.js';
import { startWorker } from './queue.js';

const app = express();
app.set('trust proxy', 1);
// The tracking pixel is embedded by mail clients, so it must be loadable cross-origin.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use('/webhooks', webhookRoutes);
app.use(express.json({ limit: '2mb' }));

const origins = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',').map((s) => s.trim().replace(/\/+$/, ''));
const apiCors = cors({ origin: origins });

app.get('/health', (_req, res) => res.json({ ok: true, service: 'wynmail' }));
app.use('/t', trackRoutes);
app.use(formRoutes);
app.use('/v1', v1Routes);
app.use('/api', apiCors);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/workspaces/:workspaceId', requireAuth, requireWorkspace, workspaceRoutes);

app.use((err, _req, res, _next) => {
  if (err.code === '22P02') return res.status(400).json({ error: 'bad request' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: 'bad request' });
  console.error(err);
  res.status(500).json({ error: 'server error' });
});

const port = Number(process.env.PORT || 4000);
await migrate();
// Unconfirmed signups are personal data we no longer need after their link expires plus 30 days.
setInterval(() => query(`DELETE FROM form_signups WHERE confirmed_at IS NULL AND expires_at < now() - interval '30 days'`).catch(() => {}), 3600000).unref();
if (process.env.RUN_WORKER !== '0') startWorker();
app.listen(port, () => console.log(`Wynmail API on :${port}`));
