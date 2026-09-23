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
import { csvLine } from '../csvout.js';
import { checkDomain } from '../dnscheck.js';
import { createResetToken, resetLink } from '../resets.js';
import { sendSystemEmail, actionEmail } from '../sysmail.js';
import formsAdmin from './formsAdmin.js';
import segmentsAdmin from './segmentsAdmin.js';
import profileRoutes from './profile.js';
import mediaAdmin from './media.js';
import analyticsRoutes from './analytics.js';
import { compileSegment } from '../segments.js';
import automationsAdmin from './automationsAdmin.js';
import { isEmail, normEmail, DOMAIN_RE, TRACKING_RE, cleanName, cleanText, cleanAttrs, senderAllowed, readDesign } from '../validate.js';

const router = Router({ mergeParams: true });
const ws = (req) => req.workspace.id;
const bad = (res, msg) => res.status(400).json({ error: msg });
const MAX_HTML = 500000;
const MAX_IMPORT_ROWS = 5000;

router.param('id', (_req, res, next, v) => (/^\d{1,9}$/.test(v) ? next() : bad(res, 'bad id')));

const isAdmin = async (uid) => !!(await one(`SELECT is_admin FROM users WHERE id = $1`, [uid]))?.is_admin;
const ownsSegment = async (workspaceId, id) => !!(await one(`SELECT 1 FROM segments WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]));
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
    const t = String(f.tracking_domain ?? '').trim().toLowerCase();
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
      const d = String(f.sending_domain ?? '').trim().toLowerCase();
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
    `SELECT l.*, (SELECT count(*)::int FROM list_contacts lc WHERE lc.list_id = l.id) AS contact_count,
       (SELECT count(*)::int FROM list_contacts lc JOIN contacts c ON c.id = lc.contact_id
        WHERE lc.list_id = l.id AND c.status = 'subscribed') AS subscribed_count
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
  const params = [ws(req)];
  const where = ['c.workspace_id = $1'];
  const listId = /^\d{1,9}$/.test(String(req.query.listId || '')) ? Number(req.query.listId) : null;
  if (listId) { params.push(listId); where.push(`EXISTS (SELECT 1 FROM list_contacts lc WHERE lc.contact_id = c.id AND lc.list_id = $${params.length})`); }
  if (typeof req.query.q === 'string' && req.query.q) { params.push(req.query.q.slice(0, 100)); where.push(`c.email ILIKE '%' || $${params.length} || '%'`); }
  if (['subscribed', 'unsubscribed', 'bounced', 'complained'].includes(req.query.status)) { params.push(req.query.status); where.push(`c.status = $${params.length}`); }
  if (typeof req.query.tag === 'string' && req.query.tag.trim()) { params.push(req.query.tag.trim().toLowerCase().slice(0, 30)); where.push(`$${params.length} = ANY(c.tags)`); }
  if (/^\d{1,9}$/.test(String(req.query.segmentId || ''))) {
    const seg = await one(`SELECT definition FROM segments WHERE id = $1 AND workspace_id = $2`, [Number(req.query.segmentId), ws(req)]);
    if (!seg) return res.status(404).json({ error: 'segment not found' });
    where.push(compileSegment(seg.definition, params));
  }
  res.json(await many(`SELECT c.* FROM contacts c WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT 500`, params));
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
    await upsertContact(ws(req), { ...c, consent_source: 'csv-import' }, listId, { source: 'import' });
  }
  res.json({ imported: parsed.contacts.length, skipped: parsed.skipped, duplicates: parsed.duplicates, errors: parsed.errors });
});

router.delete('/contacts/:id', async (req, res) => {
  const gone = await one(`DELETE FROM contacts WHERE id = $1 AND workspace_id = $2 RETURNING email`, [req.params.id, ws(req)]);
  // Deleting a contact also erases their signup and consent log entries.
  if (gone) await query(`DELETE FROM form_signups WHERE workspace_id = $1 AND email = $2`, [ws(req), gone.email]);
  res.json({ ok: true });
});

/* ---------- templates ---------- */
router.get('/templates', async (req, res) => {
  res.json(await many(`SELECT * FROM templates WHERE workspace_id = $1 ORDER BY id DESC`, [ws(req)]));
});

router.post('/templates', async (req, res) => {
  const { name, subject, html } = req.body || {};
  const dz = readDesign(req.body?.design);
  if (dz.error) return bad(res, dz.error);
  res.json(await one(
    `INSERT INTO templates (workspace_id, name, subject, html, design) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
    [ws(req), cleanName(name) || 'Untitled', cleanText(subject, 300), String(html || '').slice(0, MAX_HTML), dz.value]
  ));
});

router.put('/templates/:id', async (req, res) => {
  const { name, subject, html } = req.body || {};
  const dz = readDesign(req.body?.design);
  if (dz.error) return bad(res, dz.error);
  const row = await one(
    `UPDATE templates SET name = COALESCE($3, name), subject = COALESCE($4, subject),
       html = COALESCE($5, html), design = CASE WHEN $6::boolean THEN $7::jsonb ELSE design END, updated_at = now()
     WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    [req.params.id, ws(req), name === undefined ? null : cleanName(name),
     subject === undefined ? null : cleanText(subject, 300), html === undefined ? null : String(html).slice(0, MAX_HTML), dz.set, dz.value]
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
    `SELECT c.*, l.name AS list_name, sg.name AS segment_name,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id) AS total,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.status = 'sent') AS sent,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.opened_at IS NOT NULL) AS opened,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.clicked_at IS NOT NULL) AS clicked,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.bounced_at IS NOT NULL) AS bounced,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.complained_at IS NOT NULL) AS complained,
       (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.delivered_at IS NOT NULL) AS delivered
     FROM campaigns c LEFT JOIN lists l ON l.id = c.list_id LEFT JOIN segments sg ON sg.id = c.segment_id
     WHERE c.workspace_id = $1 ORDER BY c.id DESC`, [ws(req)]));
});

router.post('/campaigns', async (req, res) => {
  const { name, subject, html, list_id, segment_id, scheduled_at, preview_text } = req.body || {};
  const subj = cleanText(subject, 300);
  const seg = segment_id ? Number(segment_id) : null;
  const lst = !seg && list_id ? Number(list_id) : null; // a segment replaces the list
  if (!subj || (!lst && !seg)) return bad(res, 'subject and a list or segment are required');
  if (lst && !(await ownsList(ws(req), lst))) return bad(res, 'unknown list');
  if (seg && !(await ownsSegment(ws(req), seg))) return bad(res, 'unknown segment');
  const when = scheduled_at ? new Date(scheduled_at) : null;
  if (when && Number.isNaN(when.getTime())) return bad(res, 'invalid schedule time');
  const dz = readDesign(req.body?.design);
  if (dz.error) return bad(res, dz.error);
  res.json(await one(
    `INSERT INTO campaigns (workspace_id, name, subject, html, list_id, scheduled_at, status, preview_text, design, segment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10) RETURNING *`,
    [ws(req), cleanName(name) || subj, subj, String(html || '').slice(0, MAX_HTML), lst, when, when ? 'scheduled' : 'draft', cleanText(preview_text, 150), dz.value, seg]
  ));
});

router.put('/campaigns/:id', async (req, res) => {
  const { name, subject, html, list_id, segment_id, scheduled_at, preview_text } = req.body || {};
  const audienceGiven = !!req.body && ('list_id' in req.body || 'segment_id' in req.body);
  const seg = segment_id ? Number(segment_id) : null;
  const lst = !seg && list_id ? Number(list_id) : null;
  if (audienceGiven && !lst && !seg) return bad(res, 'Choose a list or segment');
  if (lst && !(await ownsList(ws(req), lst))) return bad(res, 'unknown list');
  if (seg && !(await ownsSegment(ws(req), seg))) return bad(res, 'unknown segment');
  const when = scheduled_at ? new Date(scheduled_at) : null;
  if (when && Number.isNaN(when.getTime())) return bad(res, 'invalid schedule time');
  const dz = readDesign(req.body?.design);
  if (dz.error) return bad(res, dz.error);
  const row = await one(
    `UPDATE campaigns SET name = COALESCE($3, name), subject = COALESCE($4, subject),
       html = COALESCE($5, html), list_id = CASE WHEN $11::boolean THEN $6 ELSE list_id END, segment_id = CASE WHEN $11::boolean THEN $12 ELSE segment_id END, scheduled_at = $7,
       preview_text = COALESCE($8, preview_text),
       design = CASE WHEN $9::boolean THEN $10::jsonb ELSE design END,
       status = CASE WHEN $7::timestamptz IS NOT NULL THEN 'scheduled' ELSE 'draft' END
     WHERE id = $1 AND workspace_id = $2 AND status IN ('draft','scheduled') RETURNING *`,
    [req.params.id, ws(req), name === undefined ? null : cleanName(name),
     subject === undefined ? null : cleanText(subject, 300), html === undefined ? null : String(html).slice(0, MAX_HTML),
     lst, when, preview_text === undefined ? null : cleanText(preview_text, 150), dz.set, dz.value, audienceGiven, seg]
  );
  if (!row) return res.status(404).json({ error: 'not found or already sent' });
  res.json(row);
});

router.post('/campaigns/:id/send', async (req, res) => {
  const campaign = await one(`SELECT id, subject, html FROM campaigns WHERE id = $1 AND workspace_id = $2`, [req.params.id, ws(req)]);
  if (!campaign) return res.status(404).json({ error: 'not found' });
  if (!campaign.html.trim()) return bad(res, 'This campaign has no content yet. Add some HTML first');
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
    subject: campaign.subject, html: campaign.html, token: 'preview', preheader: campaign.preview_text
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
  const built = buildEmail({ workspace: w, contact: { email: to, first_name: first, attributes: {} }, subject: `[Test] ${subject}`, html, token: 'preview', preheader: cleanText(req.body?.preview_text, 150) });
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

router.use('/forms', formsAdmin);
router.use('/segments', segmentsAdmin);
router.use('/profile', profileRoutes);
router.use('/media', mediaAdmin);
router.use('/analytics', analyticsRoutes);
router.use('/automations', automationsAdmin);

/* ---------- blocked addresses ---------- */
async function liftBlock(workspaceId, email) {
  await query(`DELETE FROM suppressions WHERE workspace_id = $1 AND email = $2`, [workspaceId, email]);
  await query(`UPDATE contacts SET status = 'subscribed' WHERE workspace_id = $1 AND email = $2 AND status IN ('bounced', 'complained')`, [workspaceId, email]);
}

router.get('/suppressions', async (req, res) => {
  res.json(await many(
    `SELECT s.id, s.email, s.reason, s.created_at, c.id AS contact_id, c.status AS contact_status
     FROM suppressions s LEFT JOIN contacts c ON c.workspace_id = s.workspace_id AND c.email = s.email
     WHERE s.workspace_id = $1 ORDER BY s.id DESC LIMIT 200`, [ws(req)]));
});

// Unblocking affects your sender reputation, so only the workspace owner can do it, and people who
// reported spam need an explicit confirmation.
async function unblockGuard(req, res, reason) {
  if (!(await canManageTeam(req))) { res.status(403).json({ error: 'Only the workspace owner can unblock addresses' }); return false; }
  if (reason === 'complained' && req.body?.confirm !== true) {
    bad(res, 'This person reported one of your emails as spam. Confirm that you want to email them again');
    return false;
  }
  return true;
}

router.post('/suppressions/:id/unblock', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return bad(res, 'bad id');
  if (!(await canManageTeam(req))) return res.status(403).json({ error: 'Only the workspace owner can unblock addresses' });
  const row = await one(`SELECT email, reason FROM suppressions WHERE id = $1 AND workspace_id = $2`, [Number(req.params.id), ws(req)]);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!(await unblockGuard(req, res, row.reason))) return;
  await liftBlock(ws(req), row.email);
  res.json({ ok: true });
});

router.post('/contacts/:id/unblock', async (req, res) => {
  if (!(await canManageTeam(req))) return res.status(403).json({ error: 'Only the workspace owner can unblock addresses' });
  const c = await one(`SELECT email, status FROM contacts WHERE id = $1 AND workspace_id = $2`, [req.params.id, ws(req)]);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (!['bounced', 'complained'].includes(c.status)) return bad(res, 'This contact is not blocked. Unsubscribed people can only come back by confirming a signup form');
  if (!(await unblockGuard(req, res, c.status))) return;
  await liftBlock(ws(req), c.email);
  res.json({ ok: true });
});

/* ---------- exports ---------- */
const exportLimit = rateLimit({ windowMs: 3600000, max: 20, key: (req) => `x${req.workspace.id}` });
const sendCsv = (res, name, lines) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
};

router.get('/contacts/export', exportLimit, async (req, res) => {
  const rows = await many(
    `SELECT c.email, c.first_name, c.last_name, c.status, c.consent_source, c.consent_at, c.created_at, c.attributes,
       (SELECT string_agg(l.name, '; ' ORDER BY l.name) FROM list_contacts lc JOIN lists l ON l.id = lc.list_id WHERE lc.contact_id = c.id) AS lists
     FROM contacts c WHERE c.workspace_id = $1 ORDER BY c.id LIMIT 50000`, [ws(req)]);
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.attributes || {})))].slice(0, 20);
  sendCsv(res, 'contacts.csv', [
    csvLine(['email', 'first_name', 'last_name', 'status', 'lists', 'consent_source', 'consent_at', 'created_at', ...keys]),
    ...rows.map((r) => csvLine([r.email, r.first_name, r.last_name, r.status, r.lists, r.consent_source, r.consent_at, r.created_at, ...keys.map((k) => (r.attributes || {})[k])]))
  ]);
});

router.get('/campaigns/:id/export', exportLimit, async (req, res) => {
  const c = await one(`SELECT name FROM campaigns WHERE id = $1 AND workspace_id = $2`, [req.params.id, ws(req)]);
  if (!c) return res.status(404).json({ error: 'not found' });
  const rows = await many(
    `SELECT email, status, sent_at, delivered_at, opened_at, open_count, clicked_at, click_count, bounced_at, bounce_type, complained_at, unsubscribed_at, error
     FROM messages WHERE campaign_id = $1 AND workspace_id = $2 ORDER BY id LIMIT 100000`, [req.params.id, ws(req)]);
  sendCsv(res, 'campaign-report.csv', [
    csvLine(['email', 'status', 'sent_at', 'delivered_at', 'opened_at', 'open_count', 'clicked_at', 'click_count', 'bounced_at', 'bounce_type', 'complained_at', 'unsubscribed_at', 'error']),
    ...rows.map((r) => csvLine([r.email, r.status, r.sent_at, r.delivered_at, r.opened_at, r.open_count, r.clicked_at, r.click_count, r.bounced_at, r.bounce_type, r.complained_at, r.unsubscribed_at, r.error]))
  ]);
});

router.post('/campaigns/:id/duplicate', async (req, res) => {
  const c = await one(`SELECT * FROM campaigns WHERE id = $1 AND workspace_id = $2`, [req.params.id, ws(req)]);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(await one(
    `INSERT INTO campaigns (workspace_id, name, subject, html, list_id, preview_text, status, design, segment_id) VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7::jsonb, $8) RETURNING *`,
    [ws(req), cleanName(`Copy of ${c.name}`, 100), c.subject, c.html, c.list_id, c.preview_text, c.design ? JSON.stringify(c.design) : null, c.segment_id]));
});

/* ---------- domain check ---------- */
const domainLimit = rateLimit({ windowMs: 60000, max: 12, key: (req) => `d${req.workspace.id}` });
router.get('/domain-check', domainLimit, async (req, res) => {
  const domain = String(req.workspace.sending_domain || '').toLowerCase();
  if (!domain) return bad(res, 'Your sending domain has not been approved yet. Ask an admin to set it');
  const tracking = String(req.workspace.tracking_domain || '').toLowerCase();
  if (domain === 'resend.dev') {
    return res.json({ domain, checks: [], note: 'You are using the shared Resend test domain, so there are no DNS records to check. Once you verify your own domain, set it as the sending domain and check it here.' });
  }
  res.json({ domain, checks: await checkDomain({ domain, tracking }) });
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
