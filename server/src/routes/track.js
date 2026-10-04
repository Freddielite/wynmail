import { Router } from 'express';
import { many, one, query } from '../db.js';
import { safeEqual } from '../config.js';
import { linkSig } from '../render.js';
import { classifyUa } from '../ua.js';
import express from 'express';
import { rateLimit } from '../rateLimit.js';
import { prefsPage } from '../pages.js';
import { attachLists } from '../contacts.js';

const router = Router();
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const TOKEN_RE = /^[a-f0-9]{32}$/;

const findMessage = async (token) => (TOKEN_RE.test(token) ? one(`SELECT * FROM messages WHERE token = $1`, [token]) : null);

router.get('/o/:token', async (req, res) => {
  const message = await findMessage(req.params.token.replace(/\.png$/, ''));
  const ua = classifyUa(req.headers['user-agent']);
  if (message && ua.device !== 'bot') {
    await query(`UPDATE messages SET open_count = open_count + 1, opened_at = COALESCE(opened_at, now()) WHERE id = $1`, [message.id]);
    await query(`INSERT INTO events (workspace_id, message_id, type, meta) VALUES ($1, $2, 'open', $3::jsonb)`, [message.workspace_id, message.id, JSON.stringify({ device: ua.device, proxy: ua.proxy })]);
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
  const ua = classifyUa(req.headers['user-agent']);
  // Security scanners open every link the moment an email arrives. A click within five seconds of
  // sending is not a person, so it is not counted. The visitor is still sent on to the page.
  const tooFast = message?.sent_at && Date.now() - new Date(message.sent_at).getTime() < 5000;
  if (message && ua.device !== 'bot' && !tooFast) {
    await query(`UPDATE messages SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, now()) WHERE id = $1`, [message.id]);
    await query(`INSERT INTO events (workspace_id, message_id, type, url, meta) VALUES ($1, $2, 'click', $3, $4::jsonb)`, [message.workspace_id, message.id, url, JSON.stringify({ device: ua.device })]);
  }
  res.redirect(302, url);
});

async function unsubscribe(token) {
  const message = await findMessage(token);
  if (!message) return null;
  await query(`UPDATE contacts SET status = 'unsubscribed', unsubscribed_at = now() WHERE id = $1 AND status = 'subscribed'`, [message.contact_id]);
  await query(`UPDATE messages SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE id = $1`, [message.id]);
  await query(`INSERT INTO events (workspace_id, message_id, type) VALUES ($1, $2, 'unsubscribe')`, [message.workspace_id, message.id]);
  return message;
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;font:16px/1.6 system-ui,Segoe UI,Arial,sans-serif;background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:40px;max-width:420px;text-align:center">
<h1 style="margin:0 0 8px;font-size:22px">${title}</h1>${body}
<p style="margin-top:24px;font-size:13px;color:#94a3b8">Delivered by Wynmail</p></div></body></html>`;

const prefsLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 60 });
const form = express.urlencoded({ extended: false, limit: '10kb' });

async function prefsContext(token) {
  const message = await findMessage(token);
  if (!message) return null;
  const ws = await one(`SELECT id, name, preference_center FROM workspaces WHERE id = $1`, [message.workspace_id]);
  const contact = await one(`SELECT id, email, status, paused_until, max_per_week FROM contacts WHERE id = $1 AND workspace_id = $2`, [message.contact_id, message.workspace_id]);
  if (!ws || !contact) return null;
  return { message, ws, contact };
}
const memberLists = (ctx) => many(
  `SELECT l.id, l.name FROM list_contacts lc JOIN lists l ON l.id = lc.list_id
   WHERE lc.contact_id = $1 AND l.workspace_id = $2 AND l.show_in_prefs ORDER BY l.name`, [ctx.contact.id, ctx.ws.id]);
const leftLists = (ctx) => many(
  `SELECT l.id, l.name FROM list_optouts o JOIN lists l ON l.id = o.list_id
   WHERE o.contact_id = $1 AND l.workspace_id = $2 AND l.show_in_prefs ORDER BY l.name`, [ctx.contact.id, ctx.ws.id]);

// GET only shows a page. Link scanners and mail previewers that prefetch URLs must not be able to
// change anyone's preferences or unsubscribe them. Every change is a POST (also RFC 8058 one-click).
router.get('/u/:token', async (req, res) => {
  const ctx = TOKEN_RE.test(req.params.token) ? await prefsContext(req.params.token) : null;
  if (!ctx) return res.set('Content-Type', 'text/html').send(page('Link not recognised', '<p style="margin:0;color:#475569">This unsubscribe link is invalid or expired.</p>'));
  if (ctx.ws.preference_center && ctx.contact.status === 'subscribed') {
    const notice = { saved: 'Your preferences are saved.', paused: 'Done. We will not email you during the pause.', resumed: 'Welcome back. Emails are on again.' }[req.query.done];
    return res.set({ 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).send(prefsPage({ ws: ctx.ws, contact: ctx.contact, lists: await memberLists(ctx), left: await leftLists(ctx), token: req.params.token, notice }));
  }
  res.set('Content-Type', 'text/html').send(page('Unsubscribe', `<p style="margin:0 0 20px;color:#475569">Stop receiving emails from this sender?</p>
        <form method="post" action="/t/u/${req.params.token}"><button type="submit"
        style="border:0;cursor:pointer;font:600 15px system-ui;padding:12px 26px;border-radius:999px;color:#fff;background:linear-gradient(135deg,#0b2a5b,#2f80ed)">Confirm unsubscribe</button></form>`));
});

router.post('/p/:token', prefsLimit, form, async (req, res) => {
  const ctx = TOKEN_RE.test(req.params.token) ? await prefsContext(req.params.token) : null;
  if (!ctx || ctx.contact.status !== 'subscribed') return res.status(400).set('Content-Type', 'text/html').send(page('Link not recognised', '<p style="margin:0;color:#475569">This link is invalid or expired.</p>'));
  const b = req.body || {};
  const log = (meta) => query(`INSERT INTO events (workspace_id, message_id, type, meta) VALUES ($1, $2, 'prefs', $3::jsonb)`, [ctx.ws.id, ctx.message.id, JSON.stringify(meta)]);
  let done = 'saved';

  if (b.action === 'pause') {
    const days = Number(b.days) === 90 ? 90 : 30;
    await query(`UPDATE contacts SET paused_until = now() + interval '1 day' * $2 WHERE id = $1`, [ctx.contact.id, days]);
    await log({ action: 'pause', days });
    done = 'paused';
  } else if (b.action === 'resume') {
    await query(`UPDATE contacts SET paused_until = NULL WHERE id = $1`, [ctx.contact.id]);
    await log({ action: 'resume' });
    done = 'resumed';
  } else {
    // Only lists this person is on, or left, can change. Ids from the form are never trusted on their own.
    const member = (await memberLists(ctx)).map((l) => l.id), left = (await leftLists(ctx)).map((l) => l.id);
    const asArray = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
    const keep = new Set(asArray(b.keep).map(Number));
    const leaving = member.filter((id) => !keep.has(id));
    const rejoining = left.filter((id) => keep.has(id));
    if (leaving.length) {
      await query(`DELETE FROM list_contacts WHERE contact_id = $1 AND list_id = ANY($2::int[])`, [ctx.contact.id, leaving]);
      await query(`INSERT INTO list_optouts (contact_id, list_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`, [ctx.contact.id, leaving]);
    }
    if (rejoining.length) await attachLists(ctx.ws.id, ctx.contact.id, rejoining, { source: 'prefs' });
    const freq = [0, 1, 2].includes(Number(b.freq)) ? Number(b.freq) : 0;
    await query(`UPDATE contacts SET max_per_week = $2 WHERE id = $1`, [ctx.contact.id, freq || null]);
    await log({ action: 'save', left: leaving.length, rejoined: rejoining.length, max_per_week: freq });
  }
  res.redirect(303, `/t/u/${req.params.token}?done=${done}`);
});

router.post('/u/:token', async (req, res) => {
  const message = await unsubscribe(req.params.token);
  res.set('Content-Type', 'text/html').send(message
    ? page('You are unsubscribed', '<p style="margin:0;color:#475569">You will not receive further emails from this sender.</p>')
    : page('Link not recognised', '<p style="margin:0;color:#475569">This unsubscribe link is invalid or expired.</p>'));
});

export default router;
