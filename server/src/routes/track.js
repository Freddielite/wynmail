import { Router } from 'express';
import { one, query } from '../db.js';
import { safeEqual } from '../config.js';
import { linkSig } from '../render.js';

const router = Router();
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const TOKEN_RE = /^[a-f0-9]{32}$/;

const findMessage = async (token) => (TOKEN_RE.test(token) ? one(`SELECT * FROM messages WHERE token = $1`, [token]) : null);

router.get('/o/:token', async (req, res) => {
  const message = await findMessage(req.params.token.replace(/\.png$/, ''));
  if (message) {
    await query(`UPDATE messages SET open_count = open_count + 1, opened_at = COALESCE(opened_at, now()) WHERE id = $1`, [message.id]);
    await query(`INSERT INTO events (workspace_id, message_id, type) VALUES ($1, $2, 'open')`, [message.workspace_id, message.id]);
  }
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).send(PIXEL);
});

// Redirect only if the signature proves Wynmail generated this exact link. No open redirect.
router.get('/c/:token', async (req, res) => {
  const { url, sig } = req.query;
  if (typeof url !== 'string' || typeof sig !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url)) {
    return res.status(400).send('bad link');
  }
  if (!safeEqual(sig, linkSig(req.params.token, url))) return res.status(400).send('bad link');

  const message = await findMessage(req.params.token);
  if (message) {
    await query(`UPDATE messages SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, now()) WHERE id = $1`, [message.id]);
    await query(`INSERT INTO events (workspace_id, message_id, type, url) VALUES ($1, $2, 'click', $3)`, [message.workspace_id, message.id, url]);
  }
  res.redirect(302, url);
});

async function unsubscribe(token) {
  const message = await findMessage(token);
  if (!message) return null;
  await query(`UPDATE contacts SET status = 'unsubscribed', unsubscribed_at = now() WHERE id = $1 AND status = 'subscribed'`, [message.contact_id]);
  await query(`INSERT INTO events (workspace_id, message_id, type) VALUES ($1, $2, 'unsubscribe')`, [message.workspace_id, message.id]);
  return message;
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;font:16px/1.6 system-ui,Segoe UI,Arial,sans-serif;background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:40px;max-width:420px;text-align:center">
<h1 style="margin:0 0 8px;font-size:22px">${title}</h1>${body}
<p style="margin-top:24px;font-size:13px;color:#94a3b8">Delivered by Wynmail</p></div></body></html>`;

// GET only shows a confirmation button. Link scanners and mail previewers that prefetch
// URLs must not be able to unsubscribe people. The POST does the work (also RFC 8058 one-click).
router.get('/u/:token', async (req, res) => {
  const message = await findMessage(req.params.token);
  res.set('Content-Type', 'text/html').send(message
    ? page('Unsubscribe', `<p style="margin:0 0 20px;color:#475569">Stop receiving emails from this sender?</p>
        <form method="post" action="/t/u/${req.params.token}"><button type="submit"
        style="border:0;cursor:pointer;font:600 15px system-ui;padding:12px 26px;border-radius:999px;color:#fff;background:linear-gradient(135deg,#0b2a5b,#2f80ed)">Confirm unsubscribe</button></form>`)
    : page('Link not recognised', '<p style="margin:0;color:#475569">This unsubscribe link is invalid or expired.</p>'));
});

router.post('/u/:token', async (req, res) => {
  const message = await unsubscribe(req.params.token);
  res.set('Content-Type', 'text/html').send(message
    ? page('You are unsubscribed', '<p style="margin:0;color:#475569">You will not receive further emails from this sender.</p>')
    : page('Link not recognised', '<p style="margin:0;color:#475569">This unsubscribe link is invalid or expired.</p>'));
});

export default router;
