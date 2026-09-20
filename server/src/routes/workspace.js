import { Router } from 'express';
import { many, one, query } from '../db.js';
import { enqueueCampaign } from '../queue.js';
import { buildEmail } from '../render.js';
import { upsertContact } from '../contacts.js';
import { newKey } from '../apikeys.js';
import { publicWorkspace } from '../auth.js';
import { encrypt, decrypt } from '../config.js';
import { hash } from '../auth.js';
import crypto from 'crypto';
import { getProvider } from '../providers/index.js';
import { throttled } from '../throttle.js';
import { sentToday } from '../usage.js';
import { rateLimit } from '../rateLimit.js';
import { parseCsv, readContacts } from '../csv.js';
import { createResetToken, resetLink } from '../resets.js';
import { sendSystemEmail, actionEmail } from '../sysmail.js';
import { isEmail, normEmail, DOMAIN_RE, TRACKING_RE, cleanName, cleanText, cleanAttrs, senderAllowed } from '../validate.js';

const router = Router({ mergeParams: true });
const ws = (req) => req.workspace.id;
const bad = (res, msg) => res.status(400).json({ error: msg });
const MAX_HTML = 500000;
const MAX_IMPORT_ROWS = 5000;

router.param('id', (_req, res, next, v) => (/^\d{1,9}$/.test(v) ? next() : bad(res, 'bad id')));

const isAdmin = async (uid) => !!(await one(`SELECT is_admin FROM users WHERE id = $1`, [uid]))?.is_admin;
const ownsList = async (workspaceId, listId) =>
  !!(await one(`SELECT 1 FROM lists WHERE id = $1 AND workspace_id = $2`, [listId, workspaceId]));

/* ---------- workspace settings ---------- */
router.get('/', (req, res) => res.json(publicWorkspace(req.workspace)));

router.put('/', async (req, res) => {
  const f = req.body || {};
  const admin = await isAdmin(req.user.uid);
  const v = {};

  if (f.name !== undefined) { v.name = cleanName(f.name); if (!v.name) return bad(res, 'name required'); }
  if (f.from_name !== undefined) v.from_name = cleanName(f.from_name);
  if (f.footer_address !== undefined) v.footer_address = cleanText(f.footer_address, 300);
  if (f.reply_to !== undefined) {
    v.reply_to = normEmail(f.reply_to);
    if (v.reply_to && !isEmail(v.reply_to)) return bad(res, 'reply to is not a valid email');
  }
  if (f.tracking_domain !== undefined) {
    const t = String(f.tracking_domain).trim().toLowerCase();
    const plainHttp = /^http:\/\//.test(t) && !/^http:\/\/localhost(:|$)/.test(t);
    if (t && (t.length > 253 || !TRACKING_RE.test(t) || plainHttp)) {
      return bad(res, 'tracking domain must be a hostname like track.example.com');
    }
    v.tracking_domain = t;
  }

  // Limits, provider choice and the approved sending domain are admin-only.
  let sendingDomain = (req.workspace.sending_domain || '').toLowerCase();
  if (admin) {
    if (f.sending_domain !== undefined) {
      const d = String(f.sending_domain).trim().toLowerCase();
      if (d && !DOMAIN_RE.test(d)) return bad(res, 'invalid sending domain');
      v.sending_domain = d; sendingDomain = d;
    }
    if (f.rate_per_minute !== undefined) {
      const n = Number(f.rate_per_minute);
      if (!Number.isInteger(n) || n < 1 || n > 1000) return bad(res, 'emails per minute must be 1 to 1000');
      v.rate_per_minute = n;
    }
    if (f.daily_limit !== undefined) {
      const n = Number(f.daily_limit);
      if (!Number.isInteger(n) || n < 0 || n > 100000) return bad(res, 'daily limit must be 0 to 100000');
      v.daily_limit = n;
    }
    if (f.provider !== undefined) {
      if (!['resend', 'console'].includes(f.provider)) return bad(res, 'unknown provider');
      v.provider = f.provider;
    }
  }

  if (f.from_email !== undefined) {
    const e = normEmail(f.from_email);
    if (e) {
      if (!isEmail(e)) return bad(res, 'from email is not valid');
      if (!sendingDomain) return bad(res, 'an admin must approve a sending domain first');
      const d = e.split('@')[1];
      if (!(d === sendingDomain || d.endsWith('.' + sendingDomain))) return bad(res, `from email must use ${sendingDomain}`);
    }
    v.from_email = e;
  }

  const newKey = typeof f.provider_api_key === 'string' && f.provider_api_key.trim() ? encrypt(f.provider_api_key.trim()) : null;
  const newHook = typeof f.webhook_secret === 'string' && f.webhook_secret.trim() ? encrypt(f.webhook_secret.trim()) : null;

  const row = await one(
    `UPDATE workspaces SET
       name = COALESCE($2, name), sending_domain = COALESCE($3, sending_domain),
       from_name = COALESCE($4, from_name), from_email = COALESCE($5, from_email),
       reply_to = COALESCE($6, reply_to), tracking_domain = COALESCE($7, tracking_domain),
       footer_address = COALESCE($8, footer_address), rate_per_minute = COALESCE($9, rate_per_minute),
       daily_limit = COALESCE($10, daily_limit), provider = COALESCE($11, provider),
       provider_api_key = CASE WHEN $13::boolean THEN NULL ELSE COALESCE($12, provider_api_key) END,
       webhook_secret = CASE WHEN $15::boolean THEN NULL ELSE COALESCE($14, webhook_secret) END
     WHERE id = $1 RETURNING *`,
    [ws(req), v.name, v.sending_domain, v.from_name, v.from_email, v.reply_to, v.tracking_domain,
     v.footer_address, v.rate_per_minute, v.daily_limit, v.provider, newKey, f.clear_provider_key === true,
     newHook, f.clear_webhook_secret === true]
  );
  res.json(publicWorkspace(row));
});

/* ---------- lists ---------- */
router.get('/lists', async (req, res) => {
  res.json(await many(
    `SELECT l.*, (SELECT count(*)::int FROM list_contacts lc WHERE lc.list_id = l.id) AS contact_count
     FROM lists l WHERE l.workspace_id = $1 ORDER BY l.id DESC`, [ws(req)]));
});

router.post('/lists', async (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return bad(res, 'name required');
  res.json(await one(`INSERT INTO lists (workspace_id, name) VALUES ($1, $2) RETURNING *`, [ws(req), name]));
});

router.delete('/lists/:id', async (req, res) => {
  await query(`DELETE FROM lists WHERE id = $1 AND workspace_id = $2`, [req.params.id, ws(req)]);
  res.json({ ok: true });
});

/* ---------- contacts ---------- */
router.get('/contacts', async (req, res) => {
  const listId = /^\d{1,9}$/.test(String(req.query.listId || '')) ? Number(req.query.listId) : null;
  const q = typeof req.query.q === 'string' && req.query.q ? req.query.q.slice(0, 100) : null;
  res.json(await many(
    `SELECT DISTINCT c.* FROM contacts c
     LEFT JOIN list_contacts lc ON lc.contact_id = c.id
     WHERE c.workspace_id = $1
       AND ($2::int IS NULL OR lc.list_id = $2::int)
       AND ($3::text IS NULL OR c.email ILIKE '%' || $3 || '%')
     ORDER BY c.id DESC LIMIT 500`,
    [ws(req), listId, q]
  ));
});

router.post('/contacts', async (req, res) => {
  if (!isEmail(normEmail(req.body?.email))) return bad(res, 'valid email required');
  const listId = req.body.list_id ? Number(req.body.list_id) : null;
  if (listId && !(await ownsList(ws(req), listId))) return bad(res, 'unknown list');
  res.json(await upsertContact(ws(req), req.body, listId));
});

// CSV import. Handles quoted commas, semicolon files, BOMs and duplicate rows. Existing
// unsubscribed, bounced or complained contacts keep their status.
router.post('/contacts/import', async (req, res) => {
  const { csv, list_id } = req.body || {};
  if (typeof csv !== 'string' || !csv.trim()) return bad(res, 'csv required');
  const listId = list_id ? Number(list_id) : null;
  if (listId && !(await ownsList(ws(req), listId))) return bad(res, 'unknown list');

  const parsed = readContacts(parseCsv(csv), { maxRows: MAX_IMPORT_ROWS, isEmail, normEmail });
  if (parsed.error) return bad(res, parsed.error);

  for (const c of parsed.contacts) {
    await upsertContact(ws(req), { ...c, consent_source: 'csv-import' }, listId);
  }
  res.json({ imported: parsed.contacts.length, skipped: parsed.skipped, duplicates: parsed.duplicates, errors: parsed.errors });
});

router.delete('/contacts/:id', async (req, res) => {
  await query(`DELETE FROM contacts WHERE id = $1 AND workspace_id = $2`, [req.params.id, ws(req)]);
  res.json({ ok: true });
});

/* ---------- templates ---------- */
router.get('/templates', async (req, res) => {
  res.json(await many(`SELECT * FROM templates WHERE workspace_id = $1 ORDER BY id DESC`, [ws(req)]));
});

router.post('/templates', async (req, res) => {
  const { name, subject, html } = req.body || {};
  res.json(await one(
    `INSERT INTO templates (workspace_id, name, subject, html) VALUES ($1, $2, $3, $4) RETURNING *`,
    [ws(req), cleanName(name) || 'Untitled', cleanText(subject, 300), String(html || '').slice(0, MAX_HTML)]
  ));
});

router.put('/templates/:id', async (req, res) => {
  const { name, subject, html } = req.body || {};
  const row = await one(
    `UPDATE templates SET name = COALESCE($3, name), subject = COALESCE($4, subject),
       html = COALESCE($5, html), updated_at = now()
     WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    [req.params.id, ws(req), name === undefined ? null : cleanName(name),
     subject === undefined ? null : cleanText(subject, 300), html === undefined ? null : String(html).slice(0, MAX_HTML)]
  );
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

router.delete('/templates/:id', async (req, res) => {
  await query(`DELETE FROM templates WHERE id = $1 AND workspace_id = $2`, [req.params.id, ws(req)]);
  res.json({ ok: true });
});

/* ---------- campaigns ---------- */
router.get('/campaigns', async (req, res) => {
  res.json(await many(
    `SELECT c.*, l.name AS list_name,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id) AS total,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.status = 'sent') AS sent,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.opened_at IS NOT NULL) AS opened,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.clicked_at IS NOT NULL) AS clicked,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.bounced_at IS NOT NULL) AS bounced,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.complained_at IS NOT NULL) AS complained,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.delivered_at IS NOT NULL) AS delivered
     FROM campaigns c LEFT JOIN lists l ON l.id = c.list_id
     WHERE c.workspace_id = $1 ORDER BY c.id DESC`, [ws(req)]));
});

router.post('/campaigns', async (req, res) => {
  const { name, subject, html, list_id, scheduled_at } = req.body || {};
  const subj = cleanText(subject, 300);
  if (!subj || !list_id) return bad(res, 'subject and list_id required');
  if (!(await ownsList(ws(req), Number(list_id)))) return bad(res, 'unknown list');
  const when = scheduled_at ? new Date(scheduled_at) : null;
  if (when && Number.isNaN(when.getTime())) return bad(res, 'invalid schedule time');
  res.json(await one(
    `INSERT INTO campaigns (workspace_id, name, subject, html, list_id, scheduled_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [ws(req), cleanName(name) || subj, subj, String(html || '').slice(0, MAX_HTML), Number(list_id), when, when ? 'scheduled' : 'draft']
  ));
});

router.put('/campaigns/:id', async (req, res) => {
  const { name, subject, html, list_id, scheduled_at } = req.body || {};
  if (list_id && !(await ownsList(ws(req), Number(list_id)))) return bad(res, 'unknown list');
  const when = scheduled_at ? new Date(scheduled_at) : null;
  if (when && Number.isNaN(when.getTime())) return bad(res, 'invalid schedule time');
  const row = await one(
    `UPDATE campaigns SET name = COALESCE($3, name), subject = COALESCE($4, subject),
       html = COALESCE($5, html), list_id = COALESCE($6, list_id), scheduled_at = $7,
       status = CASE WHEN $7::timestamptz IS NOT NULL THEN 'scheduled' ELSE 'draft' END
     WHERE id = $1 AND workspace_id = $2 AND status IN ('draft','scheduled') RETURNING *`,
    [req.params.id, ws(req), name === undefined ? null : cleanName(name),
     subject === undefined ? null : cleanText(subject, 300), html === undefined ? null : String(html).slice(0, MAX_HTML),
     list_id ? Number(list_id) : null, when]
  );
  if (!row) return res.status(404).json({ error: 'not found or already sent' });
  res.json(row);
});

router.post('/campaigns/:id/send', async (req, res) => {
  const campaign = await one(`SELECT id FROM campaigns WHERE id = $1 AND workspace_id = $2`, [req.params.id, ws(req)]);
  if (!campaign) return res.status(404).json({ error: 'not found' });
  if (!senderAllowed(req.workspace)) {
    return bad(res, 'sender not approved: an admin must set your sending domain, and your from email must use it');
  }
  if (!req.workspace.footer_address) return bad(res, 'add a footer postal address in settings first');
  try {
    res.json({ queued: await enqueueCampaign(campaign.id) });
  } catch (err) {
    bad(res, err.message);
  }
});

router.get('/campaigns/:id/preview', async (req, res) => {
  const campaign = await one(`SELECT * FROM campaigns WHERE id = $1 AND workspace_id = $2`, [req.params.id, ws(req)]);
  if (!campaign) return res.status(404).json({ error: 'not found' });
  const contact = /^\d{1,9}$/.test(String(req.query.contact_id || ''))
    ? await one(`SELECT * FROM contacts WHERE id = $1 AND workspace_id = $2`, [req.query.contact_id, ws(req)])
    : await one(`SELECT * FROM contacts WHERE workspace_id = $1 ORDER BY id LIMIT 1`, [ws(req)]);
  const built = buildEmail({
    workspace: req.workspace,
    contact: contact || { email: 'preview@example.com', first_name: 'there', attributes: {} },
    subject: campaign.subject, html: campaign.html, token: 'preview'
  });
  res.json({ subject: built.subject, html: built.html });
});

router.get('/campaigns/:id/messages', async (req, res) => {
  res.json(await many(
    `SELECT id, email, token, provider_id, status, sent_at, delivered_at, bounced_at, bounce_type, complained_at, opened_at, clicked_at, open_count, click_count, error
     FROM messages WHERE campaign_id = $1 AND workspace_id = $2 ORDER BY id DESC LIMIT 500`,
    [req.params.id, ws(req)]));
});

/* ---------- API keys ---------- */
router.get('/api-keys', async (req, res) => {
  res.json(await many(
    `SELECT id, name, prefix, last_used_at, created_at FROM api_keys
     WHERE workspace_id = $1 AND revoked_at IS NULL ORDER BY id DESC`, [ws(req)]));
});

router.post('/api-keys', async (req, res) => {
  const name = cleanName(req.body?.name) || 'Untitled key';
  const { n } = await one(`SELECT count(*)::int AS n FROM api_keys WHERE workspace_id = $1 AND revoked_at IS NULL`, [ws(req)]);
  if (n >= 10) return bad(res, 'You can have at most 10 active keys. Revoke one first.');
  const { key, prefix, hash } = newKey();
  const row = await one(
    `INSERT INTO api_keys (workspace_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4)
     RETURNING id, name, prefix, created_at`, [ws(req), name, prefix, hash]);
  res.json({ ...row, key }); // the full key is shown this once and never stored
});

router.delete('/api-keys/:id', async (req, res) => {
  await query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`, [req.params.id, ws(req)]);
  res.json({ ok: true });
});

router.get('/api-emails', async (req, res) => {
  res.json(await many(
    `SELECT id, to_email, subject, status, error, bounced_at, created_at FROM api_emails
     WHERE workspace_id = $1 AND kind = 'api' ORDER BY id DESC LIMIT 25`, [ws(req)]));
});

/* ---------- test email ---------- */
const testLimit = rateLimit({ windowMs: 3600000, max: 10, key: (req) => `test${req.workspace.id}` });

// Sends the current draft to yourself. Recipients are limited to members of this workspace.
router.post('/test-email', testLimit, async (req, res) => {
  const w = req.workspace;
  if (!senderAllowed(w)) return bad(res, 'Sender not approved: an admin must set your sending domain, and your from email must use it');
  if (!w.footer_address) return bad(res, 'Add a footer postal address in settings first');
  const subject = cleanText(req.body?.subject, 290);
  const html = String(req.body?.html || '').slice(0, MAX_HTML);
  if (!subject || !html.trim()) return bad(res, 'Add a subject and some content first');

  const me = await one(`SELECT email, name FROM users WHERE id = $1`, [req.user.uid]);
  let to = me.email;
  if (req.body?.to !== undefined) {
    const wanted = normEmail(req.body.to);
    const member = await one(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.email = $2`, [w.id, wanted]);
    if (!member) return bad(res, 'Test emails can only go to members of this workspace');
    to = wanted;
  }
  if ((await sentToday(w.id)) >= (w.daily_limit || 0)) return res.status(429).json({ error: `Daily sending limit reached (${w.daily_limit})` });

  const first = (me.name || '').split(' ')[0] || to.split('@')[0];
  const built = buildEmail({ workspace: w, contact: { email: to, first_name: first, attributes: {} }, subject: `[Test] ${subject}`, html, token: 'preview' });
  const rec = await one(`INSERT INTO api_emails (workspace_id, to_email, subject, kind) VALUES ($1, $2, $3, 'test') RETURNING id`, [w.id, to, built.subject]);
  try {
    const result = await throttled(() => getProvider(w).send({
      to, from: `${w.from_name || w.name} <${w.from_email}>`, replyTo: w.reply_to || undefined,
      apiKey: decrypt(w.provider_api_key) || undefined, ...built
    }));
    await query(`UPDATE api_emails SET status = 'sent', provider_id = $2 WHERE id = $1`, [rec.id, result.id || null]);
    res.json({ ok: true, to });
  } catch (err) {
    await query(`UPDATE api_emails SET status = 'failed', error = $2 WHERE id = $1`, [rec.id, String(err.message).slice(0, 500)]);
    res.status(502).json({ error: `The test email could not be sent: ${String(err.message).slice(0, 200)}` });
  }
});

/* ---------- team ---------- */
const canManageTeam = async (req) => req.workspace.role === 'owner' || (await isAdmin(req.user.uid));
const MAX_MEMBERS = 20;

router.get('/members', async (req, res) => {
  res.json({
    can_manage: await canManageTeam(req),
    data: await many(
      `SELECT u.id AS user_id, u.email, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 ORDER BY (m.role = 'owner') DESC, u.email`, [ws(req)])
  });
});

router.post('/members', async (req, res) => {
  if (!(await canManageTeam(req))) return res.status(403).json({ error: 'Only the workspace owner can add people' });
  const email = normEmail(req.body?.email);
  if (!isEmail(email)) return bad(res, 'Enter a valid email address');
  const { n } = await one(`SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1`, [ws(req)]);
  if (n >= MAX_MEMBERS) return bad(res, `A workspace can have at most ${MAX_MEMBERS} people`);

  const existing = await one(`SELECT id FROM users WHERE email = $1`, [email]);
  if (existing) {
    await query(`INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [existing.id, ws(req)]);
    return res.json({ email, invited: false, message: 'They already have an account and can now switch into this workspace.' });
  }

  // New person: create the account with a random password nobody knows, and let them set their own.
  const user = await one(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`, [email, await hash(crypto.randomBytes(24).toString('hex'))]);
  await query(`INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'member')`, [user.id, ws(req)]);
  const link = resetLink(await createResetToken(user.id, 72));
  let emailed = false;
  try {
    const { html, text } = actionEmail({
      heading: `You have been added to ${req.workspace.name} on Wynmail`,
      body: 'Choose a password to get started. The link works once and expires in 3 days.',
      label: 'Set your password', url: link, note: 'If you were not expecting this, you can ignore the email.'
    });
    await sendSystemEmail({ to: email, subject: `Join ${req.workspace.name} on Wynmail`, html, text });
    emailed = true;
  } catch (err) {
    console.error('[invite]', err.message);
  }
  res.json({ email, invited: true, emailed, invite_link: link });
});

router.delete('/members/:userId', async (req, res) => {
  if (!(await canManageTeam(req))) return res.status(403).json({ error: 'Only the workspace owner can remove people' });
  if (!/^\d{1,9}$/.test(req.params.userId)) return bad(res, 'bad id');
  const done = await one(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2 AND role = 'member' RETURNING user_id`, [ws(req), Number(req.params.userId)]);
  if (!done) return bad(res, 'That person cannot be removed');
  res.json({ ok: true });
});

/* ---------- dashboard ---------- */
router.get('/stats', async (req, res) => {
  const stats = await one(
    `SELECT
       (SELECT count(*)::int FROM contacts WHERE workspace_id = $1 AND status = 'subscribed') AS subscribers,
       (SELECT count(*)::int FROM lists WHERE workspace_id = $1) AS lists,
       (SELECT count(*)::int FROM campaigns WHERE workspace_id = $1) AS campaigns,
       (SELECT count(*)::int FROM messages WHERE workspace_id = $1 AND status = 'sent') AS sent,
       (SELECT count(*)::int FROM messages WHERE workspace_id = $1 AND opened_at IS NOT NULL) AS opened,
       (SELECT count(*)::int FROM messages WHERE workspace_id = $1 AND clicked_at IS NOT NULL) AS clicked,
       (SELECT count(*)::int FROM messages WHERE workspace_id = $1 AND status = 'queued') AS queued,
       (SELECT count(*)::int FROM messages WHERE workspace_id = $1 AND bounced_at IS NOT NULL) AS bounced,
       (SELECT count(*)::int FROM messages WHERE workspace_id = $1 AND complained_at IS NOT NULL) AS complained,
       ((SELECT count(*) FROM messages WHERE workspace_id = $1 AND sent_at >= date_trunc('day', now())) + (SELECT count(*) FROM api_emails WHERE workspace_id = $1 AND status = 'sent' AND created_at >= date_trunc('day', now())))::int AS sent_today`,
    [ws(req)]
  );
  res.json({ ...stats, daily_limit: req.workspace.daily_limit });
});

export default router;
