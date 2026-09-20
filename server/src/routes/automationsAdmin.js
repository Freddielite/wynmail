import { Router } from 'express';
import { many, one, query } from '../db.js';
import { cleanName, cleanText, senderAllowed } from '../validate.js';

const router = Router({ mergeParams: true });
const bad = (res, msg) => res.status(400).json({ error: msg });
const wid = (req) => req.workspace.id;
const idOf = (req) => (/^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : null);
const MAX_AUTOMATIONS = 25;
const MAX_STEPS = 10;
const MAX_DELAY = 60 * 24 * 365; // one year, in minutes
const MAX_HTML = 500000;

function readAutomation(b) {
  const name = cleanName(b.name, 80);
  if (!name) return { error: 'Give the automation a name' };
  const steps = Array.isArray(b.steps) ? b.steps : [];
  if (steps.length < 1) return { error: 'Add at least one email' };
  if (steps.length > MAX_STEPS) return { error: `An automation can have at most ${MAX_STEPS} emails` };
  const out = [];
  for (const [i, s] of steps.entries()) {
    const subject = cleanText(s?.subject, 300);
    const html = String(s?.html || '').slice(0, MAX_HTML);
    const delay = Number(s?.delay_minutes ?? 0);
    if (!subject) return { error: `Email ${i + 1} needs a subject` };
    if (!html.trim()) return { error: `Email ${i + 1} has no content yet` };
    if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY) return { error: `Email ${i + 1} has an invalid delay` };
    out.push({ delay_minutes: delay, subject, html });
  }
  return { value: { name, include_imports: b.include_imports === true, active: b.active !== false, steps: out } };
}

const ownsList = async (workspaceId, listId) => !!(await one(`SELECT 1 FROM lists WHERE id = $1 AND workspace_id = $2`, [listId, workspaceId]));

// Turning an automation on needs the same sender setup as sending a campaign.
function readiness(ws) {
  if (!senderAllowed(ws)) return 'To turn this on, an admin must approve your sending domain and your from email must use it';
  if (!ws.footer_address) return 'Add a footer postal address in Settings before turning this on';
  return null;
}

router.get('/', async (req, res) => {
  res.json(await many(
    `SELECT a.*, l.name AS list_name,
       (SELECT count(*)::int FROM automation_steps s WHERE s.automation_id = a.id) AS steps,
       (SELECT count(*)::int FROM automation_runs r WHERE r.automation_id = a.id) AS enrolled,
       (SELECT count(*)::int FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'active') AS in_progress,
       (SELECT count(*)::int FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'completed') AS completed,
       (SELECT count(*)::int FROM messages m WHERE m.automation_id = a.id AND m.status = 'sent') AS sent,
       (SELECT count(*)::int FROM messages m WHERE m.automation_id = a.id AND m.opened_at IS NOT NULL) AS opened,
       (SELECT count(*)::int FROM messages m WHERE m.automation_id = a.id AND m.clicked_at IS NOT NULL) AS clicked
     FROM automations a LEFT JOIN lists l ON l.id = a.list_id
     WHERE a.workspace_id = $1 ORDER BY a.id DESC`, [wid(req)]));
});

router.get('/:id', async (req, res) => {
  if (!idOf(req)) return bad(res, 'bad id');
  const a = await one(`SELECT * FROM automations WHERE id = $1 AND workspace_id = $2`, [idOf(req), wid(req)]);
  if (!a) return res.status(404).json({ error: 'not found' });
  const steps = await many(
    `SELECT s.id, s.position, s.delay_minutes, s.subject, s.html,
       (SELECT count(*)::int FROM messages m WHERE m.step_id = s.id AND m.status = 'sent') AS sent,
       (SELECT count(*)::int FROM messages m WHERE m.step_id = s.id AND m.opened_at IS NOT NULL) AS opened,
       (SELECT count(*)::int FROM messages m WHERE m.step_id = s.id AND m.clicked_at IS NOT NULL) AS clicked
     FROM automation_steps s WHERE s.automation_id = $1 ORDER BY s.position`, [a.id]);
  res.json({ ...a, steps });
});

router.get('/:id/runs', async (req, res) => {
  if (!idOf(req)) return bad(res, 'bad id');
  res.json(await many(
    `SELECT r.id, c.email, r.status, r.current_step, r.next_at, r.created_at, r.completed_at,
       (SELECT count(*)::int FROM automation_steps s WHERE s.automation_id = r.automation_id) AS total_steps
     FROM automation_runs r JOIN automations a ON a.id = r.automation_id JOIN contacts c ON c.id = r.contact_id
     WHERE r.automation_id = $1 AND a.workspace_id = $2 ORDER BY r.id DESC LIMIT 25`, [idOf(req), wid(req)]));
});

async function saveSteps(automationId, steps) {
  // Update in place by position so step ids, and the stats attached to them, stay stable.
  const existing = await many(`SELECT position FROM automation_steps WHERE automation_id = $1`, [automationId]);
  const have = new Set(existing.map((e) => e.position));
  for (const [i, s] of steps.entries()) {
    if (have.has(i)) {
      await query(`UPDATE automation_steps SET delay_minutes = $3, subject = $4, html = $5 WHERE automation_id = $1 AND position = $2`,
        [automationId, i, s.delay_minutes, s.subject, s.html]);
    } else {
      await query(`INSERT INTO automation_steps (automation_id, position, delay_minutes, subject, html) VALUES ($1, $2, $3, $4, $5)`,
        [automationId, i, s.delay_minutes, s.subject, s.html]);
    }
  }
  await query(`DELETE FROM automation_steps WHERE automation_id = $1 AND position >= $2`, [automationId, steps.length]);
}

router.post('/', async (req, res) => {
  const { value: v, error } = readAutomation(req.body || {});
  if (error) return bad(res, error);
  const listId = Number(req.body?.list_id);
  if (!listId || !(await ownsList(wid(req), listId))) return bad(res, 'Choose the list that starts this automation');
  const { n } = await one(`SELECT count(*)::int AS n FROM automations WHERE workspace_id = $1`, [wid(req)]);
  if (n >= MAX_AUTOMATIONS) return bad(res, `A workspace can have at most ${MAX_AUTOMATIONS} automations`);
  if (v.active) { const problem = readiness(req.workspace); if (problem) return bad(res, problem); }
  const a = await one(
    `INSERT INTO automations (workspace_id, name, list_id, status, include_imports) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [wid(req), v.name, listId, v.active ? 'active' : 'paused', v.include_imports]);
  await saveSteps(a.id, v.steps);
  res.json(a);
});

router.put('/:id', async (req, res) => {
  if (!idOf(req)) return bad(res, 'bad id');
  const { value: v, error } = readAutomation(req.body || {});
  if (error) return bad(res, error);
  const listId = Number(req.body?.list_id);
  if (!listId || !(await ownsList(wid(req), listId))) return bad(res, 'Choose the list that starts this automation');
  if (v.active) { const problem = readiness(req.workspace); if (problem) return bad(res, problem); }
  const a = await one(
    `UPDATE automations SET name = $3, list_id = $4, status = $5, include_imports = $6 WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    [idOf(req), wid(req), v.name, listId, v.active ? 'active' : 'paused', v.include_imports]);
  if (!a) return res.status(404).json({ error: 'not found' });
  await saveSteps(a.id, v.steps);
  res.json(a);
});

router.post('/:id/status', async (req, res) => {
  if (!idOf(req)) return bad(res, 'bad id');
  const active = req.body?.active === true;
  if (active) { const problem = readiness(req.workspace); if (problem) return bad(res, problem); }
  const a = await one(`UPDATE automations SET status = $3 WHERE id = $1 AND workspace_id = $2 RETURNING *`, [idOf(req), wid(req), active ? 'active' : 'paused']);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
});

router.delete('/:id', async (req, res) => {
  if (!idOf(req)) return bad(res, 'bad id');
  await query(`DELETE FROM automations WHERE id = $1 AND workspace_id = $2`, [idOf(req), wid(req)]);
  res.json({ ok: true });
});

export default router;
