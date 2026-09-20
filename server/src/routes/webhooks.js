import crypto from 'crypto';
import express, { Router } from 'express';
import { one, query } from '../db.js';
import { decrypt, safeEqual } from '../config.js';
import { cleanText } from '../validate.js';

const router = Router();
router.use(express.raw({ type: '*/*', limit: '1mb' }));

// Resend signs webhooks with Svix: HMAC-SHA256 over "id.timestamp.body" using the base64 secret.
function verifySignature(secret, headers, raw) {
  const id = headers['svix-id'];
  const ts = headers['svix-timestamp'];
  const sigs = headers['svix-signature'];
  if (!secret || !id || !ts || !sigs) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw.toString('utf8')}`).digest('base64');
  return String(sigs).split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && safeEqual(sig || '', expected);
  });
}

async function suppress(workspaceId, email, reason) {
  await query(
    `INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, email) DO UPDATE SET
       reason = CASE WHEN suppressions.reason = 'complained' THEN 'complained' ELSE EXCLUDED.reason END`,
    [workspaceId, email, reason]
  );
  // Never override an unsubscribe, and let a complaint upgrade an earlier bounce.
  await query(
    `UPDATE contacts SET status = $3 WHERE workspace_id = $1 AND email = $2
     AND (status = 'subscribed' OR (status = 'bounced' AND $3 = 'complained'))`,
    [workspaceId, email, reason]
  );
}

async function applyEvent(event, workspaceId) {
  const type = event?.type;
  const data = event?.data || {};
  const providerId = data.email_id;
  if (!type || !providerId) return;

  const scope = workspaceId ? ' AND workspace_id = $2' : '';
  const params = workspaceId ? [providerId, workspaceId] : [providerId];
  const msg = await one(`SELECT id, workspace_id, email FROM messages WHERE provider_id = $1${scope}`, params);
  const api = msg ? null : await one(`SELECT id, workspace_id, to_email AS email FROM api_emails WHERE provider_id = $1${scope}`, params);
  const target = msg || api;
  if (!target) return;

  if (type === 'email.delivered' && msg) {
    await query(`UPDATE messages SET delivered_at = COALESCE(delivered_at, now()) WHERE id = $1`, [msg.id]);
  } else if (type === 'email.bounced') {
    const bounceType = cleanText(data.bounce?.type || 'Undetermined', 30);
    const reason = cleanText(data.bounce?.message || '', 300) || null;
    if (msg) {
      await query(`UPDATE messages SET bounced_at = COALESCE(bounced_at, now()), bounce_type = $2, error = COALESCE($3, error) WHERE id = $1`, [msg.id, bounceType, reason]);
      await query(`INSERT INTO events (workspace_id, message_id, type, meta) VALUES ($1, $2, 'bounce', $3)`, [msg.workspace_id, msg.id, JSON.stringify({ type: bounceType })]);
    } else {
      await query(`UPDATE api_emails SET bounced_at = COALESCE(bounced_at, now()), error = COALESCE($2, error) WHERE id = $1`, [api.id, reason]);
    }
    // Only permanent bounces suppress. Full mailboxes and similar are temporary.
    if (bounceType === 'Permanent') await suppress(target.workspace_id, target.email, 'bounced');
  } else if (type === 'email.complained') {
    if (msg) {
      await query(`UPDATE messages SET complained_at = COALESCE(complained_at, now()) WHERE id = $1`, [msg.id]);
      await query(`INSERT INTO events (workspace_id, message_id, type) VALUES ($1, $2, 'complaint')`, [msg.workspace_id, msg.id]);
    }
    await suppress(target.workspace_id, target.email, 'complained');
  }
}

async function handle(req, res, secret, workspaceId) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!verifySignature(secret, req.headers, raw)) return res.status(401).json({ error: 'bad signature' });
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'bad json' }); }
  await applyEvent(event, workspaceId);
  res.json({ ok: true });
}

// Shared Wyntek Resend account.
router.post('/resend', (req, res) => {
  if (!process.env.RESEND_WEBHOOK_SECRET) return res.status(503).json({ error: 'webhook secret is not configured' });
  return handle(req, res, process.env.RESEND_WEBHOOK_SECRET, null);
});

// A client with their own Resend account points their webhook here with their own signing secret.
router.post('/resend/:workspaceId', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.workspaceId)) return res.status(404).json({ error: 'not found' });
  const ws = await one(`SELECT id, webhook_secret FROM workspaces WHERE id = $1`, [Number(req.params.workspaceId)]);
  if (!ws?.webhook_secret) return res.status(404).json({ error: 'not found' });
  let secret;
  try { secret = decrypt(ws.webhook_secret); } catch { return res.status(500).json({ error: 'secret unreadable' }); }
  return handle(req, res, secret, ws.id);
});

export default router;
