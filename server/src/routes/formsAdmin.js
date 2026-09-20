import crypto from 'crypto';
import { Router } from 'express';
import { many, one, query } from '../db.js';
import { cleanName, cleanText } from '../validate.js';
import { trackingBase } from '../render.js';

const router = Router({ mergeParams: true });
const bad = (res, msg) => res.status(400).json({ error: msg });
const wid = (req) => req.workspace.id;
const id = (req) => (/^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : null);
const MAX_FORMS = 25;

const withUrl = (req, f) => ({ ...f, url: `${trackingBase(req.workspace)}/f/${f.slug}` });

function readForm(b) {
  const out = {};
  out.name = cleanName(b.name, 80);
  if (!out.name) return { error: 'Give the form a name' };
  out.title = cleanText(b.title, 120) || 'Subscribe';
  out.description = cleanText(b.description, 500);
  out.button_label = cleanText(b.button_label, 40) || 'Subscribe';
  out.ask_names = b.ask_names !== false;
  out.consent_text = cleanText(b.consent_text, 400);
  if (out.consent_text.length < 10) return { error: 'Write the consent sentence people agree to (at least 10 characters)' };
  out.double_optin = b.double_optin !== false;
  out.success_message = cleanText(b.success_message, 300) || 'Thanks! Check your inbox to confirm your subscription.';
  out.confirm_subject = cleanText(b.confirm_subject, 150) || 'Confirm your subscription';
  out.confirm_body = cleanText(b.confirm_body, 600) || 'Please confirm your email address to finish subscribing.';
  out.active = b.active !== false;
  out.redirect_url = cleanText(b.redirect_url, 500);
  if (out.redirect_url) {
    try {
      const u = new URL(out.redirect_url);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    } catch { return { error: 'The redirect address must start with http:// or https://' }; }
  }
  return { value: out };
}

const ownsList = async (workspaceId, listId) => !!(await one(`SELECT 1 FROM lists WHERE id = $1 AND workspace_id = $2`, [listId, workspaceId]));

router.get('/', async (req, res) => {
  const rows = await many(
    `SELECT f.*, l.name AS list_name,
       (SELECT count(*)::int FROM form_signups s WHERE s.form_id = f.id AND s.confirmed_at IS NOT NULL) AS confirmed,
       (SELECT count(*)::int FROM form_signups s WHERE s.form_id = f.id AND s.confirmed_at IS NULL AND s.expires_at > now()) AS pending
     FROM forms f LEFT JOIN lists l ON l.id = f.list_id WHERE f.workspace_id = $1 ORDER BY f.id DESC`, [wid(req)]);
  res.json(rows.map((f) => withUrl(req, f)));
});

router.post('/', async (req, res) => {
  const { value: v, error } = readForm(req.body || {});
  if (error) return bad(res, error);
  const listId = Number(req.body?.list_id);
  if (!listId || !(await ownsList(wid(req), listId))) return bad(res, 'Choose the list this form adds people to');
  const { n } = await one(`SELECT count(*)::int AS n FROM forms WHERE workspace_id = $1`, [wid(req)]);
  if (n >= MAX_FORMS) return bad(res, `A workspace can have at most ${MAX_FORMS} forms`);
  const slug = `${v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'form'}-${crypto.randomBytes(4).toString('hex')}`;
  const row = await one(
    `INSERT INTO forms (workspace_id, name, slug, list_id, title, description, button_label, ask_names, consent_text,
       double_optin, success_message, redirect_url, confirm_subject, confirm_body, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [wid(req), v.name, slug, listId, v.title, v.description, v.button_label, v.ask_names, v.consent_text, v.double_optin,
     v.success_message, v.redirect_url, v.confirm_subject, v.confirm_body, v.active]);
  res.json(withUrl(req, row));
});

router.put('/:id', async (req, res) => {
  if (!id(req)) return bad(res, 'bad id');
  const { value: v, error } = readForm(req.body || {});
  if (error) return bad(res, error);
  const listId = Number(req.body?.list_id);
  if (!listId || !(await ownsList(wid(req), listId))) return bad(res, 'Choose the list this form adds people to');
  const row = await one(
    `UPDATE forms SET name=$3, list_id=$4, title=$5, description=$6, button_label=$7, ask_names=$8, consent_text=$9,
       double_optin=$10, success_message=$11, redirect_url=$12, confirm_subject=$13, confirm_body=$14, active=$15
     WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    [id(req), wid(req), v.name, listId, v.title, v.description, v.button_label, v.ask_names, v.consent_text, v.double_optin,
     v.success_message, v.redirect_url, v.confirm_subject, v.confirm_body, v.active]);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(withUrl(req, row));
});

router.delete('/:id', async (req, res) => {
  if (!id(req)) return bad(res, 'bad id');
  await query(`DELETE FROM forms WHERE id = $1 AND workspace_id = $2`, [id(req), wid(req)]);
  res.json({ ok: true });
});

router.get('/:id/signups', async (req, res) => {
  if (!id(req)) return bad(res, 'bad id');
  res.json(await many(
    `SELECT s.id, s.email, s.email_status, s.email_error, s.created_at, s.confirmed_at,
       CASE WHEN s.confirmed_at IS NOT NULL THEN 'confirmed' WHEN s.expires_at < now() THEN 'expired' ELSE 'pending' END AS status
     FROM form_signups s JOIN forms f ON f.id = s.form_id
     WHERE s.form_id = $1 AND f.workspace_id = $2 ORDER BY s.id DESC LIMIT 25`, [id(req), wid(req)]));
});

export default router;
