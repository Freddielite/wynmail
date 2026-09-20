import { Router } from 'express';
import { many, one, query } from '../db.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../config.js';
import { merge } from '../render.js';
import { throttled } from '../throttle.js';
import { hashKey } from '../apikeys.js';
import { upsertContact, attachLists } from '../contacts.js';
import { isEmail, normEmail, cleanName, cleanText, cleanAttrs, senderAllowed } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { sentToday } from '../usage.js';

const router = Router();
const fail = (res, status, error) => res.status(status).json({ error });
const MAX_HTML = 500000;

async function requireKey(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!/^wm_[\w-]{20,60}$/.test(key)) {
    return fail(res, 401, 'Missing or invalid API key. Send it as: Authorization: Bearer wm_...');
  }
  const row = await one(
    `SELECT k.id AS key_id, w.* FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL`, [hashKey(key)]);
  if (!row) return fail(res, 401, 'Invalid or revoked API key.');
  req.workspace = row;
  req.keyId = row.key_id;
  query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [row.key_id]).catch(() => {});
  next();
}

router.use(rateLimit({ windowMs: 60000, max: 300 }));
router.use(requireKey);
router.use(rateLimit({ windowMs: 60000, max: 120, key: (req) => `key${req.keyId}` }));

const wid = (req) => req.workspace.id;

/* ---------- lists ---------- */
router.get('/lists', async (req, res) => {
  res.json({ data: await many(
    `SELECT l.id, l.name, l.created_at, (SELECT count(*)::int FROM list_contacts lc WHERE lc.list_id = l.id) AS contact_count
     FROM lists l WHERE l.workspace_id = $1 ORDER BY l.id`, [wid(req)]) });
});

/* ---------- contacts ---------- */
async function contactView(workspaceId, email) {
  const c = await one(`SELECT id, email, first_name, last_name, status, attributes, created_at, unsubscribed_at FROM contacts WHERE workspace_id = $1 AND email = $2`, [workspaceId, email]);
  if (!c) return null;
  const lists = await many(`SELECT lc.list_id FROM list_contacts lc WHERE lc.contact_id = $1`, [c.id]);
  return { ...c, list_ids: lists.map((l) => l.list_id) };
}

// Add or update a contact. Pass "list" (a name, created if missing) and/or "list_ids".
router.post('/contacts', async (req, res) => {
  const b = req.body || {};
  const email = normEmail(b.email);
  if (!isEmail(email)) return fail(res, 400, '"email" must be a valid email address.');

  const ids = Array.isArray(b.list_ids) ? b.list_ids.map(Number).filter(Number.isInteger).slice(0, 20) : [];
  if (ids.length) {
    const found = await many(`SELECT id FROM lists WHERE workspace_id = $1 AND id = ANY($2::int[])`, [wid(req), ids]);
    const missing = ids.filter((i) => !found.some((f) => f.id === i));
    if (missing.length) return fail(res, 400, `Unknown list id: ${missing.join(', ')}.`);
  }
  if (typeof b.list === 'string' && b.list.trim()) {
    const name = cleanName(b.list);
    const list = (await one(`SELECT id FROM lists WHERE workspace_id = $1 AND name = $2 LIMIT 1`, [wid(req), name]))
      || (await one(`INSERT INTO lists (workspace_id, name) VALUES ($1, $2) RETURNING id`, [wid(req), name]));
    ids.push(list.id);
  }

  const contact = await upsertContact(wid(req), { ...b, email, consent_source: 'api' }, null);
  await attachLists(wid(req), contact.id, ids);
  const view = await contactView(wid(req), email);
  res.status(200).json(view);
});

router.get('/contacts/:email', async (req, res) => {
  const view = await contactView(wid(req), normEmail(req.params.email));
  if (!view) return fail(res, 404, 'Contact not found.');
  res.json(view);
});

router.post('/contacts/:email/unsubscribe', async (req, res) => {
  const email = normEmail(req.params.email);
  const done = await one(
    `UPDATE contacts SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, now())
     WHERE workspace_id = $1 AND email = $2 RETURNING id`, [wid(req), email]);
  if (!done) return fail(res, 404, 'Contact not found.');
  res.json(await contactView(wid(req), email));
});

/* ---------- campaigns (read only) ---------- */
const CAMPAIGN_SQL = `SELECT c.id, c.name, c.subject, c.status, c.list_id, c.scheduled_at, c.started_at, c.finished_at, c.created_at,
    (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id) AS total,
    (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.status = 'sent') AS sent,
    (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.status = 'failed') AS failed,
    (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.opened_at IS NOT NULL) AS opened,
    (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.clicked_at IS NOT NULL) AS clicked,
    (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.unsubscribed_at IS NOT NULL) AS unsubscribed,
    (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.delivered_at IS NOT NULL) AS delivered,
    (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.bounced_at IS NOT NULL) AS bounced,
    (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.complained_at IS NOT NULL) AS complained
  FROM campaigns c WHERE c.workspace_id = $1`;

router.get('/campaigns', async (req, res) => {
  res.json({ data: await many(`${CAMPAIGN_SQL} ORDER BY c.id DESC LIMIT 100`, [wid(req)]) });
});

router.get('/campaigns/:id', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return fail(res, 400, 'Bad campaign id.');
  const row = await one(`${CAMPAIGN_SQL} AND c.id = $2`, [wid(req), Number(req.params.id)]);
  if (!row) return fail(res, 404, 'Campaign not found.');
  res.json(row);
});

/* ---------- single transactional email ---------- */
// No unsubscribe footer and no link tracking. Still bound by the approved sending domain and the daily cap.
router.post('/emails', async (req, res) => {
  const b = req.body || {};
  const ws = req.workspace;
  const to = normEmail(b.to);
  if (!isEmail(to)) return fail(res, 400, '"to" must be one valid email address.');
  if (!senderAllowed(ws)) {
    return fail(res, 400, 'Sender not approved. Ask an admin to set your sending domain, and use a from email on that domain in Settings.');
  }

  let subject = b.subject;
  let html = b.html;
  if (b.template_id !== undefined) {
    const t = /^\d{1,9}$/.test(String(b.template_id))
      ? await one(`SELECT * FROM templates WHERE id = $1 AND workspace_id = $2`, [Number(b.template_id), ws.id]) : null;
    if (!t) return fail(res, 404, 'Template not found.');
    subject = subject ?? t.subject;
    html = html ?? t.html;
  }
  if (!cleanText(subject, 300)) return fail(res, 400, '"subject" is required.');
  if (!html && !b.text) return fail(res, 400, 'Provide "html" or "text" (or a "template_id").');

  const vars = cleanAttrs(b.variables) || {};
  const ctx = { email: to, first_name: vars.first_name, last_name: vars.last_name, attributes: vars };
  const outSubject = merge(cleanText(subject, 300), ctx).replace(/[\r\n]+/g, ' ').slice(0, 300);
  const outHtml = html ? merge(String(html).slice(0, MAX_HTML), ctx, { html: true }) : undefined;
  const outText = b.text ? merge(String(b.text).slice(0, MAX_HTML), ctx) : outHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  let replyTo = ws.reply_to || undefined;
  if (b.reply_to !== undefined) {
    if (!isEmail(normEmail(b.reply_to))) return fail(res, 400, '"reply_to" must be a valid email address.');
    replyTo = normEmail(b.reply_to);
  }

  const blocked = await one(`SELECT reason FROM suppressions WHERE workspace_id = $1 AND email = $2`, [ws.id, to]);
  if (blocked) return fail(res, 422, `Not sent: this address is blocked because it previously ${blocked.reason === 'complained' ? 'reported a message as spam' : 'bounced'}.`);
  if ((await sentToday(ws.id)) >= (ws.daily_limit || 0)) return fail(res, 429, `Daily sending limit reached (${ws.daily_limit}).`);

  const rec = await one(
    `INSERT INTO api_emails (workspace_id, api_key_id, to_email, subject) VALUES ($1, $2, $3, $4) RETURNING id`,
    [ws.id, req.keyId, to, outSubject]);
  try {
    const result = await throttled(() => getProvider(ws).send({
      to, from: `${ws.from_name || ws.name} <${ws.from_email}>`, replyTo,
      subject: outSubject, html: outHtml, text: outText, apiKey: decrypt(ws.provider_api_key) || undefined
    }));
    await query(`UPDATE api_emails SET status = 'sent', provider_id = $2 WHERE id = $1`, [rec.id, result.id || null]);
    res.json({ id: rec.id, status: 'sent', provider_id: result.id || null });
  } catch (err) {
    await query(`UPDATE api_emails SET status = 'failed', error = $2 WHERE id = $1`, [rec.id, String(err.message).slice(0, 500)]);
    res.status(502).json({ id: rec.id, error: `Delivery failed: ${String(err.message).slice(0, 300)}` });
  }
});

router.use((_req, res) => fail(res, 404, 'Unknown endpoint.'));

export default router;
