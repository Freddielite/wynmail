import { Router } from 'express';
import { many, one, query } from '../db.js';
import { cleanName, cleanText, cleanTags, senderAllowed, readDesign } from '../validate.js';

const router = Router({ mergeParams: true });
const bad = (res, msg) => res.status(400).json({ error: msg });
const wid = (req) => req.workspace.id;
const idOf = (req) => (/^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : null);
const MAX_AUTOMATIONS = 25;
const MAX_STEPS = 10;        // emails
const MAX_ALL_STEPS = 20;    // emails, conditions and tag steps together
const MAX_DELAY = 60 * 24 * 365; // one year, in minutes
const MAX_HTML = 500000;

const TRIGGERS = ['list_join', 'tag_added', 'link_click', 'date_field'];
const GOALS = ['tag', 'list', 'link'];
const COND_TYPES = ['opened', 'clicked', 'clicked_link', 'has_tag', 'on_list', 'attr_equals'];
const KEY_RE = /^\w{1,40}$/;
const one1 = (t) => cleanTags([t])[0] || '';

function readTrigger(b) {
  const type = TRIGGERS.includes(b.trigger_type) ? b.trigger_type : 'list_join';
  const out = { type, value: null, offset: 0, yearly: false };
  if (type === 'tag_added') {
    out.value = one1(b.trigger_value);
    if (!out.value) return { error: 'Type the tag that starts this automation' };
  } else if (type === 'link_click') {
    out.value = cleanText(b.trigger_value, 200);
    if (out.value.length < 3) return { error: 'Type part of the link that starts this automation, at least 3 characters' };
  } else if (type === 'date_field') {
    out.value = String(b.trigger_value || '').trim();
    if (!KEY_RE.test(out.value)) return { error: 'Type the name of the contact field that holds the date, like birthday or renewal_date' };
    out.offset = Number(b.trigger_offset_days ?? 0);
    if (!Number.isInteger(out.offset) || out.offset < -365 || out.offset > 365) return { error: 'The days before or after the date must be between -365 and 365' };
    out.yearly = b.trigger_yearly === true;
  }
  return { value: out };
}

function readGoal(b) {
  const type = GOALS.includes(b.goal_type) ? b.goal_type : null;
  if (!type) return { value: { type: null, value: null } };
  if (type === 'tag') { const v = one1(b.goal_value); return v ? { value: { type, value: v } } : { error: 'Type the tag that ends the automation' }; }
  if (type === 'list') { const v = Number(b.goal_value); return Number.isInteger(v) && v > 0 ? { value: { type, value: String(v) } } : { error: 'Choose the list that ends the automation' }; }
  const v = cleanText(b.goal_value, 200);
  return v.length >= 3 ? { value: { type, value: v } } : { error: 'Type part of the link that ends the automation, at least 3 characters' };
}

function readCond(c, i, steps) {
  if (!c || !COND_TYPES.includes(c.type)) return { error: `Step ${i + 1}: choose what to check` };
  if (c.type === 'opened' || c.type === 'clicked') {
    if (c.value === null || c.value === undefined || c.value === '') return { value: { type: c.type, value: null } };
    const v = Number(c.value);
    if (!Number.isInteger(v) || v < 0 || v >= i || steps[v]?.kind !== 'email') return { error: `Step ${i + 1}: choose an earlier email to check` };
    return { value: { type: c.type, value: v } };
  }
  if (c.type === 'clicked_link') { const v = cleanText(c.value, 200); return v.length >= 3 ? { value: { type: c.type, value: v } } : { error: `Step ${i + 1}: type part of the link to look for` }; }
  if (c.type === 'has_tag') { const v = one1(c.value); return v ? { value: { type: c.type, value: v } } : { error: `Step ${i + 1}: type the tag to look for` }; }
  if (c.type === 'on_list') { const v = Number(c.value); return Number.isInteger(v) && v > 0 ? { value: { type: c.type, value: v } } : { error: `Step ${i + 1}: choose a list` }; }
  const key = String(c.key || '').trim(), v = cleanText(c.value, 100);
  return KEY_RE.test(key) && v ? { value: { type: c.type, key, value: v } } : { error: `Step ${i + 1}: type the field name and the value to look for` };
}

// A branch goes forward to a later step, or stops, or carries on to the next step. Never backwards, so nothing can loop.
function readTarget(t, i, count) {
  if (t === null || t === undefined || t === '') return { value: null };
  const n = Number(t);
  if (n === -1) return { value: -1 };
  if (!Number.isInteger(n) || n <= i || n >= count) return { error: `Step ${i + 1}: a branch can only go forward to a later step` };
  return { value: n };
}

function readAutomation(b) {
  const name = cleanName(b.name, 80);
  if (!name) return { error: 'Give the automation a name' };
  const steps = Array.isArray(b.steps) ? b.steps : [];
  if (steps.length < 1) return { error: 'Add at least one email' };
  if (steps.length > MAX_ALL_STEPS) return { error: `An automation can have at most ${MAX_ALL_STEPS} steps` };
  const kinds = steps.map((s) => (['email', 'condition', 'tag'].includes(s?.kind) ? s.kind : 'email'));
  const emails = kinds.filter((k) => k === 'email').length;
  if (emails < 1) return { error: 'Add at least one email' };
  if (emails > MAX_STEPS) return { error: `An automation can have at most ${MAX_STEPS} emails` };
  const typed = steps.map((s, i) => ({ kind: kinds[i], s }));
  const out = [];
  for (const [i, { kind, s }] of typed.entries()) {
    const delay = Number(s?.delay_minutes ?? 0);
    if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY) return { error: `Step ${i + 1} has an invalid delay` };
    const base = { kind, delay_minutes: delay, subject: null, html: null, preview_text: '', design: null, cond: null, yes_to: null, no_to: null, tag_action: null, tag_value: null };
    if (kind === 'email') {
      const subject = cleanText(s?.subject, 300);
      const html = String(s?.html || '').slice(0, MAX_HTML);
      if (!subject) return { error: `Email ${i + 1} needs a subject` };
      if (!html.trim()) return { error: `Email ${i + 1} has no content yet` };
      const dz = readDesign(s?.design);
      if (dz.error) return { error: `Email ${i + 1}: ${dz.error}` };
      const then = readTarget(s?.then_to, i, steps.length);
      if (then.error) return { error: then.error };
      out.push({ ...base, subject, html, preview_text: cleanText(s?.preview_text, 150), design: dz.set ? dz.value : null, yes_to: then.value });
    } else if (kind === 'condition') {
      const c = readCond(s?.cond, i, typed.map((x) => x));
      if (c.error) return { error: c.error };
      const yes = readTarget(s?.yes_to, i, steps.length), no = readTarget(s?.no_to, i, steps.length);
      if (yes.error || no.error) return { error: yes.error || no.error };
      out.push({ ...base, cond: JSON.stringify(c.value), yes_to: yes.value, no_to: no.value });
    } else {
      const tag = one1(s?.tag_value);
      if (!tag) return { error: `Step ${i + 1}: type the tag` };
      const then = readTarget(s?.then_to, i, steps.length);
      if (then.error) return { error: then.error };
      out.push({ ...base, tag_action: s?.tag_action === 'remove' ? 'remove' : 'add', tag_value: tag, yes_to: then.value });
    }
  }
  const trigger = readTrigger(b);
  if (trigger.error) return { error: trigger.error };
  const goal = readGoal(b);
  if (goal.error) return { error: goal.error };
  return { value: { name, include_imports: b.include_imports === true, active: b.active !== false, steps: out, trigger: trigger.value, goal: goal.value } };
}

// Lists named in a trigger, a goal or a condition must belong to this workspace.
async function listProblem(workspaceId, v) {
  const ids = new Set();
  if (v.trigger.type === 'list_join' && v.trigger.list_id) ids.add(v.trigger.list_id);
  if (v.goal.type === 'list') ids.add(Number(v.goal.value));
  for (const st of v.steps) if (st.cond) { const c = JSON.parse(st.cond); if (c.type === 'on_list') ids.add(c.value); }
  if (!ids.size) return null;
  const have = await many(`SELECT id FROM lists WHERE workspace_id = $1 AND id = ANY($2::int[])`, [workspaceId, [...ids]]);
  return have.length === ids.size ? null : 'One of the lists you chose does not exist';
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
       (SELECT count(*)::int FROM automation_steps s WHERE s.automation_id = a.id AND s.kind = 'email') AS steps,
       (SELECT count(*)::int FROM automation_steps s WHERE s.automation_id = a.id) AS step_count,
       (SELECT count(*)::int FROM automation_runs r WHERE r.automation_id = a.id AND r.ended_reason = 'goal') AS goal_reached,
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
    `SELECT s.id, s.position, s.kind, s.cond, s.yes_to, s.no_to, s.tag_action, s.tag_value, s.delay_minutes, s.subject, s.html, s.preview_text, s.design,
       (SELECT count(*)::int FROM messages m WHERE m.step_id = s.id AND m.status = 'sent') AS sent,
       (SELECT count(*)::int FROM messages m WHERE m.step_id = s.id AND m.opened_at IS NOT NULL) AS opened,
       (SELECT count(*)::int FROM messages m WHERE m.step_id = s.id AND m.clicked_at IS NOT NULL) AS clicked
     FROM automation_steps s WHERE s.automation_id = $1 ORDER BY s.position`, [a.id]);
  res.json({ ...a, steps });
});

router.get('/:id/runs', async (req, res) => {
  if (!idOf(req)) return bad(res, 'bad id');
  res.json(await many(
    `SELECT r.id, c.email, r.status, r.ended_reason, r.current_step, r.next_at, r.created_at, r.completed_at,
       (SELECT count(*)::int FROM automation_steps s WHERE s.automation_id = r.automation_id) AS total_steps
     FROM automation_runs r JOIN automations a ON a.id = r.automation_id JOIN contacts c ON c.id = r.contact_id
     WHERE r.automation_id = $1 AND a.workspace_id = $2 ORDER BY r.id DESC LIMIT 25`, [idOf(req), wid(req)]));
});

async function saveSteps(automationId, steps) {
  // Update in place by position so step ids, and the stats attached to them, stay stable.
  const existing = await many(`SELECT position FROM automation_steps WHERE automation_id = $1`, [automationId]);
  const have = new Set(existing.map((e) => e.position));
  for (const [i, s] of steps.entries()) {
    const vals = [automationId, i, s.delay_minutes, s.kind, s.subject, s.html, s.preview_text, s.design, s.cond, s.yes_to, s.no_to, s.tag_action, s.tag_value];
    if (have.has(i)) {
      await query(`UPDATE automation_steps SET delay_minutes = $3, kind = $4, subject = $5, html = $6, preview_text = $7, design = $8::jsonb, cond = $9::jsonb,
                     yes_to = $10, no_to = $11, tag_action = $12, tag_value = $13 WHERE automation_id = $1 AND position = $2`, vals);
    } else {
      await query(`INSERT INTO automation_steps (automation_id, position, delay_minutes, kind, subject, html, preview_text, design, cond, yes_to, no_to, tag_action, tag_value)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13)`, vals);
    }
  }
  await query(`DELETE FROM automation_steps WHERE automation_id = $1 AND position >= $2`, [automationId, steps.length]);
}

// A list-join automation needs its list. The other triggers do not use one.
async function triggerList(req, v) {
  if (v.trigger.type !== 'list_join') return null;
  const listId = Number(req.body?.list_id);
  if (!listId || !(await ownsList(wid(req), listId))) return 'Choose the list that starts this automation';
  v.trigger.list_id = listId;
  return null;
}

const COLS = `trigger_type = $7, trigger_value = $8, trigger_offset_days = $9, trigger_yearly = $10, goal_type = $11, goal_value = $12, last_scan_on = NULL`;

router.post('/', async (req, res) => {
  const { value: v, error } = readAutomation(req.body || {});
  if (error) return bad(res, error);
  const problem0 = (await triggerList(req, v)) || (await listProblem(wid(req), v));
  if (problem0) return bad(res, problem0);
  const { n } = await one(`SELECT count(*)::int AS n FROM automations WHERE workspace_id = $1`, [wid(req)]);
  if (n >= MAX_AUTOMATIONS) return bad(res, `A workspace can have at most ${MAX_AUTOMATIONS} automations`);
  if (v.active) { const problem = readiness(req.workspace); if (problem) return bad(res, problem); }
  const a = await one(
    `INSERT INTO automations (workspace_id, name, list_id, status, include_imports, trigger_type, trigger_value, trigger_offset_days, trigger_yearly, goal_type, goal_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [wid(req), v.name, v.trigger.list_id || null, v.active ? 'active' : 'paused', v.include_imports, v.trigger.type, v.trigger.value, v.trigger.offset, v.trigger.yearly, v.goal.type, v.goal.value]);
  await saveSteps(a.id, v.steps);
  res.json(a);
});

router.put('/:id', async (req, res) => {
  if (!idOf(req)) return bad(res, 'bad id');
  const { value: v, error } = readAutomation(req.body || {});
  if (error) return bad(res, error);
  const problem0 = (await triggerList(req, v)) || (await listProblem(wid(req), v));
  if (problem0) return bad(res, problem0);
  if (v.active) { const problem = readiness(req.workspace); if (problem) return bad(res, problem); }
  const a = await one(
    `UPDATE automations SET name = $3, list_id = $4, status = $5, include_imports = $6, ${COLS} WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    [idOf(req), wid(req), v.name, v.trigger.list_id || null, v.active ? 'active' : 'paused', v.include_imports, v.trigger.type, v.trigger.value, v.trigger.offset, v.trigger.yearly, v.goal.type, v.goal.value]);
  if (!a) return res.status(404).json({ error: 'not found' });
  await saveSteps(a.id, v.steps);
  res.json(a);
});

router.post('/:id/status', async (req, res) => {
  if (!idOf(req)) return bad(res, 'bad id');
  const active = req.body?.active === true;
  if (active) { const problem = readiness(req.workspace); if (problem) return bad(res, problem); }
  const a = await one(`UPDATE automations SET status = $3, last_scan_on = NULL WHERE id = $1 AND workspace_id = $2 RETURNING *`, [idOf(req), wid(req), active ? 'active' : 'paused']);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
});

router.delete('/:id', async (req, res) => {
  if (!idOf(req)) return bad(res, 'bad id');
  await query(`DELETE FROM automations WHERE id = $1 AND workspace_id = $2`, [idOf(req), wid(req)]);
  res.json({ ok: true });
});

export default router;
