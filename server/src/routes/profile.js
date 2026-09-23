import { Router } from 'express';
import { many, one, query } from '../db.js';
import { cleanName, cleanAttrs, cleanTags } from '../validate.js';
import { attachLists } from '../contacts.js';

const router = Router({ mergeParams: true });
const wid = (req) => req.workspace.id;
const bad = (res, msg) => res.status(400).json({ error: msg });
const okId = (v) => /^\d{1,9}$/.test(String(v));

const load = (req) => one(
  `SELECT id, email, first_name, last_name, status, attributes, tags, consent_source, consent_at, consent_text, consent_ip, created_at, unsubscribed_at
   FROM contacts WHERE id = $1 AND workspace_id = $2`, [Number(req.params.id), wid(req)]);

router.get('/:id', async (req, res) => {
  if (!okId(req.params.id)) return bad(res, 'bad id');
  const contact = await load(req);
  if (!contact) return res.status(404).json({ error: 'not found' });

  const lists = await many(`SELECT l.id, l.name FROM list_contacts lc JOIN lists l ON l.id = lc.list_id WHERE lc.contact_id = $1 AND l.workspace_id = $2 ORDER BY l.name`, [contact.id, wid(req)]);
  const emails = await many(
    `SELECT m.id, m.status, m.sent_at, m.delivered_at, m.opened_at, m.clicked_at, m.bounced_at, m.bounce_type, m.complained_at, m.unsubscribed_at, m.open_count, m.click_count,
       c.name AS campaign_name, c.subject AS campaign_subject, a.name AS automation_name, s.subject AS step_subject
     FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id LEFT JOIN automations a ON a.id = m.automation_id LEFT JOIN automation_steps s ON s.id = m.step_id
     WHERE m.contact_id = $1 AND m.workspace_id = $2 ORDER BY m.id DESC LIMIT 50`, [contact.id, wid(req)]);
  const signups = await many(
    `SELECT s.id, f.name AS form_name, s.created_at, s.confirmed_at FROM form_signups s JOIN forms f ON f.id = s.form_id
     WHERE s.workspace_id = $1 AND s.email = $2 ORDER BY s.id DESC LIMIT 20`, [wid(req), contact.email]);
  const automations = await many(
    `SELECT a.name, r.status, r.current_step, r.next_at, (SELECT count(*)::int FROM automation_steps x WHERE x.automation_id = a.id) AS total_steps
     FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.contact_id = $1 AND a.workspace_id = $2 ORDER BY r.id DESC`, [contact.id, wid(req)]);

  const stats = { received: emails.filter((e) => e.status === 'sent').length, opened: emails.filter((e) => e.opened_at).length, clicked: emails.filter((e) => e.clicked_at).length };
  res.json({ contact, lists, emails, signups, automations, stats });
});

router.put('/:id', async (req, res) => {
  if (!okId(req.params.id)) return bad(res, 'bad id');
  const b = req.body || {};
  const attrs = b.attributes === undefined ? null : JSON.stringify(cleanAttrs(b.attributes) || {});
  const tags = b.tags === undefined ? null : cleanTags(b.tags);
  const row = await one(
    `UPDATE contacts SET first_name = CASE WHEN $3::boolean THEN $4 ELSE first_name END, last_name = CASE WHEN $5::boolean THEN $6 ELSE last_name END,
       attributes = COALESCE($7::jsonb, attributes), tags = COALESCE($8::text[], tags)
     WHERE id = $1 AND workspace_id = $2 RETURNING id`,
    [Number(req.params.id), wid(req), b.first_name !== undefined, cleanName(b.first_name, 60) || null, b.last_name !== undefined, cleanName(b.last_name, 60) || null, attrs, tags]);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(await load(req));
});

router.post('/:id/lists', async (req, res) => {
  if (!okId(req.params.id) || !okId(req.body?.list_id)) return bad(res, 'bad id');
  if (!(await load(req))) return res.status(404).json({ error: 'not found' });
  if (!(await one(`SELECT 1 FROM lists WHERE id = $1 AND workspace_id = $2`, [Number(req.body.list_id), wid(req)]))) return bad(res, 'unknown list');
  await attachLists(wid(req), Number(req.params.id), [Number(req.body.list_id)], { source: 'manual' });
  res.json({ ok: true });
});

router.delete('/:id/lists/:listId', async (req, res) => {
  if (!okId(req.params.id) || !okId(req.params.listId)) return bad(res, 'bad id');
  await query(
    `DELETE FROM list_contacts WHERE contact_id = $1 AND list_id = $2
       AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = $1 AND c.workspace_id = $3) AND EXISTS (SELECT 1 FROM lists l WHERE l.id = $2 AND l.workspace_id = $3)`,
    [Number(req.params.id), Number(req.params.listId), wid(req)]);
  res.json({ ok: true });
});

export default router;
