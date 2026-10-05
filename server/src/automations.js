import { many, one, query } from './db.js';
import { dateDue, todayIn, dayNumber, DAY_MS } from './timeutil.js';

// How long one "minute" of delay lasts. Only tests change this, to run sequences in seconds.
const MINUTE_MS = Number(process.env.AUTOMATION_MINUTE_MS || 60000);

const FIRST_STEP = `JOIN automation_steps s ON s.automation_id = a.id AND s.position = 0`;

// Called when someone is added to a list. Enrolls them in every active automation on that list.
// People added by CSV import are skipped unless the automation opts in, so a big import cannot
// email thousands of existing contacts by surprise.
export async function enroll(workspaceId, contactId, listIds, source = 'manual') {
  if (!listIds?.length) return;
  await query(
    `INSERT INTO automation_runs (automation_id, contact_id, current_step, next_at)
     SELECT a.id, c.id, 0, now() + interval '1 millisecond' * (s.delay_minutes * $5::int)
     FROM automations a
     JOIN contacts c ON c.id = $2 AND c.workspace_id = $1 AND c.status = 'subscribed'
     ${FIRST_STEP}
     WHERE a.workspace_id = $1 AND a.status = 'active' AND a.trigger_type = 'list_join' AND a.list_id = ANY($3::int[])
       AND ($4::boolean OR a.include_imports)
     ON CONFLICT DO NOTHING`,
    [workspaceId, contactId, listIds, source !== 'import', MINUTE_MS]
  );
}

// Called when tags are added to a contact, by hand, by import, by the API or by an automation step.
// Like lists, people tagged by a CSV import are skipped unless the automation opts in.
export async function enrollTags(workspaceId, contactId, tags, source = 'manual') {
  if (!tags?.length) return;
  await query(
    `INSERT INTO automation_runs (automation_id, contact_id, current_step, next_at)
     SELECT a.id, c.id, 0, now() + interval '1 millisecond' * (s.delay_minutes * $4::int)
     FROM automations a
     JOIN contacts c ON c.id = $2 AND c.workspace_id = $1 AND c.status = 'subscribed'
     ${FIRST_STEP}
     WHERE a.workspace_id = $1 AND a.status = 'active' AND a.trigger_type = 'tag_added' AND lower(a.trigger_value) = ANY($3::text[])
       AND ($5::boolean OR a.include_imports)
     ON CONFLICT DO NOTHING`,
    [workspaceId, contactId, tags.map((t) => String(t).toLowerCase()), MINUTE_MS, source !== 'import']
  );
}

// Called when a person really clicks a link in an email (not a scanner). The link only has to contain the saved text.
export async function enrollClick(workspaceId, contactId, url) {
  if (!url) return;
  const autos = await many(`SELECT id, trigger_value FROM automations WHERE workspace_id = $1 AND status = 'active' AND trigger_type = 'link_click' AND trigger_value IS NOT NULL`, [workspaceId]);
  const hit = autos.filter((a) => url.toLowerCase().includes(String(a.trigger_value).toLowerCase())).map((a) => a.id);
  if (!hit.length) return;
  await query(
    `INSERT INTO automation_runs (automation_id, contact_id, current_step, next_at)
     SELECT a.id, c.id, 0, now() + interval '1 millisecond' * (s.delay_minutes * $4::int)
     FROM automations a
     JOIN contacts c ON c.id = $2 AND c.workspace_id = $1 AND c.status = 'subscribed'
     ${FIRST_STEP}
     WHERE a.id = ANY($3::int[])
     ON CONFLICT DO NOTHING`,
    [workspaceId, contactId, hit, MINUTE_MS]
  );
}

const ymd = ({ y, mo, d }) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const fromDayNumber = (n) => { const t = new Date(n * DAY_MS); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }; };

// Once a day per automation, finds people whose date field (a birthday, a renewal) lands on today, once the
// offset is applied, and starts them. If the server was off for a few days, the missed days are caught up.
export async function scanDateTriggers(now = new Date()) {
  const autos = await many(
    `SELECT a.*, a.last_scan_on::text AS last_scan, w.default_timezone
     FROM automations a JOIN workspaces w ON w.id = a.workspace_id
     WHERE a.status = 'active' AND a.trigger_type = 'date_field' AND a.trigger_value IS NOT NULL`);
  for (const a of autos) {
    const today = todayIn(a.default_timezone, now);
    const todayNum = dayNumber(today.y, today.mo, today.d);
    let from = todayNum;
    if (a.last_scan) {
      const [y, mo, d] = a.last_scan.split('-').map(Number);
      if (dayNumber(y, mo, d) >= todayNum) continue;
      from = Math.max(dayNumber(y, mo, d) + 1, todayNum - 6);
    }
    const days = [];
    for (let n = from; n <= todayNum; n += 1) days.push(fromDayNumber(n));

    const first = await one(`SELECT delay_minutes FROM automation_steps WHERE automation_id = $1 AND position = 0`, [a.id]);
    if (!first) continue;
    const rows = await many(`SELECT id, attributes->>$2 AS v FROM contacts WHERE workspace_id = $1 AND status = 'subscribed' AND (attributes->>$2) IS NOT NULL`, [a.workspace_id, a.trigger_value]);
    const ids = [], cycles = [];
    for (const r of rows) {
      for (const day of days) {
        const cycle = dateDue(r.v, { offsetDays: a.trigger_offset_days, yearly: a.trigger_yearly, day });
        if (cycle !== null) { ids.push(r.id); cycles.push(cycle); break; }
      }
    }
    for (let i = 0; i < ids.length; i += 1000) {
      await query(
        `INSERT INTO automation_runs (automation_id, contact_id, cycle, current_step, next_at)
         SELECT $1, u.cid, u.cy, 0, now() + interval '1 millisecond' * ($4::int * $5::int)
         FROM unnest($2::int[], $3::int[]) AS u(cid, cy) ON CONFLICT DO NOTHING`,
        [a.id, ids.slice(i, i + 1000), cycles.slice(i, i + 1000), first.delay_minutes, MINUTE_MS]);
    }
    await query(`UPDATE automations SET last_scan_on = $2::date WHERE id = $1`, [a.id, ymd(today)]);
  }
}

// Has this person reached the goal that ends the sequence?
async function goalReached(a, run) {
  if (!a.goal_type || !a.goal_value) return false;
  if (a.goal_type === 'tag') return !!(await one(`SELECT 1 FROM contacts WHERE id = $1 AND $2 = ANY(tags)`, [run.contact_id, String(a.goal_value).toLowerCase()]));
  if (a.goal_type === 'list') return !!(await one(`SELECT 1 FROM list_contacts WHERE contact_id = $1 AND list_id = $2::int`, [run.contact_id, a.goal_value]));
  if (a.goal_type === 'link') {
    return !!(await one(
      `SELECT 1 FROM events e JOIN messages m ON m.id = e.message_id
       WHERE m.contact_id = $1 AND e.type = 'click' AND e.created_at >= $3 AND position(lower($2) in lower(e.url)) > 0 LIMIT 1`,
      [run.contact_id, a.goal_value, run.created_at]));
  }
  return false;
}

// The answer to a condition step. Everything is checked live, at the moment the step runs.
export async function evalCond(cond, run) {
  if (!cond) return false;
  const v = cond.value;
  switch (cond.type) {
    case 'opened':
    case 'clicked': {
      const col = cond.type === 'opened' ? 'opened_at' : 'clicked_at';
      const row = Number.isInteger(v)
        ? await one(`SELECT m.${col} AS at FROM messages m JOIN automation_steps s ON s.id = m.step_id WHERE m.run_id = $1 AND s.position = $2 ORDER BY m.id DESC LIMIT 1`, [run.id, v])
        : await one(`SELECT ${col} AS at FROM messages WHERE run_id = $1 ORDER BY id DESC LIMIT 1`, [run.id]);
      return !!row?.at;
    }
    case 'clicked_link':
      return !!(await one(
        `SELECT 1 FROM events e JOIN messages m ON m.id = e.message_id
         WHERE m.run_id = $1 AND e.type = 'click' AND position(lower($2) in lower(e.url)) > 0 LIMIT 1`, [run.id, String(v || '')]));
    case 'has_tag':
      return !!(await one(`SELECT 1 FROM contacts WHERE id = $1 AND $2 = ANY(tags)`, [run.contact_id, String(v || '').toLowerCase()]));
    case 'on_list':
      return !!(await one(`SELECT 1 FROM list_contacts WHERE contact_id = $1 AND list_id = $2::int`, [run.contact_id, Number(v) || 0]));
    case 'attr_equals':
      return !!(await one(`SELECT 1 FROM contacts WHERE id = $1 AND lower(attributes->>$2) = lower($3)`, [run.contact_id, String(cond.key || ''), String(v ?? '')]));
    default:
      return false;
  }
}

async function finish(runId, reason) {
  await query(
    `UPDATE automation_runs SET status = 'completed', completed_at = now(), next_at = NULL, ended_reason = $2,
       current_step = (SELECT count(*)::int FROM automation_steps WHERE automation_id = automation_runs.automation_id)
     WHERE id = $1`, [runId, reason]);
}

// Email and tag steps carry an optional "then": carry on, stop, or skip ahead. It is stored in yes_to.
const thenOf = (step) => step.yes_to;
async function afterStep(run, step) {
  const to = thenOf(step);
  if (to === -1) return finish(run.id, 'finished');
  return goTo(run, Number.isInteger(to) ? to : step.position + 1);
}

// Moves a run to another step, which waits its own delay first. Nothing after the last step means done.
async function goTo(run, position) {
  const next = await one(`SELECT delay_minutes FROM automation_steps WHERE automation_id = $1 AND position = $2`, [run.automation_id, position]);
  if (!next) return finish(run.id, 'finished');
  await query(`UPDATE automation_runs SET current_step = $2, next_at = now() + interval '1 millisecond' * ($3::int * $4::int) WHERE id = $1`,
    [run.id, position, next.delay_minutes, MINUTE_MS]);
}

// Turns due steps into queued messages. The normal sending queue does the rest, so rate limits,
// the daily cap, tracking, unsubscribe links and bounce handling all apply to automations too.
export async function processDueRuns() {
  const due = await many(
    `SELECT r.id FROM automation_runs r JOIN automations a ON a.id = r.automation_id
     WHERE r.status = 'active' AND a.status = 'active' AND r.next_at <= now()
     ORDER BY r.next_at LIMIT 200`
  );
  for (const { id } of due) {
    // Claiming pushes next_at forward, so two workers never handle the same run.
    const run = await one(
      `UPDATE automation_runs SET next_at = now() + interval '1 hour'
       WHERE id = $1 AND status = 'active' AND next_at <= now() RETURNING *`, [id]);
    if (!run) continue;

    const info = await one(
      `SELECT a.*, c.status AS contact_status FROM automations a, contacts c WHERE a.id = $1 AND c.id = $2`,
      [run.automation_id, run.contact_id]);
    if (!info || info.contact_status !== 'subscribed') {
      await query(`UPDATE automation_runs SET status = 'cancelled', next_at = NULL, ended_reason = 'left' WHERE id = $1`, [run.id]);
      continue;
    }
    // Someone who already did what the sequence was for gets nothing more.
    if (await goalReached(info, run)) { await finish(run.id, 'goal'); continue; }

    const step = await one(`SELECT * FROM automation_steps WHERE automation_id = $1 AND position = $2`, [run.automation_id, run.current_step]);
    if (!step) { await finish(run.id, 'finished'); continue; }

    if (step.kind === 'condition') {
      const yes = await evalCond(step.cond, run);
      const to = yes ? step.yes_to : step.no_to;
      if (to === -1) await finish(run.id, 'condition');
      else await goTo(run, Number.isInteger(to) ? to : step.position + 1);
      continue;
    }

    if (step.kind === 'tag') {
      const tag = String(step.tag_value || '').toLowerCase();
      if (tag && step.tag_action === 'remove') {
        await query(`UPDATE contacts SET tags = array_remove(tags, $2) WHERE id = $1`, [run.contact_id, tag]);
      } else if (tag) {
        const r = await one(`UPDATE contacts SET tags = ARRAY(SELECT DISTINCT unnest(tags || ARRAY[$2]::text[])) WHERE id = $1 AND NOT ($2 = ANY(tags)) AND cardinality(tags) < 50 RETURNING id`, [run.contact_id, tag]);
        if (r) await enrollTags(info.workspace_id, run.contact_id, [tag]);
      }
      await afterStep(run, step);
      continue;
    }

    await query(
      `INSERT INTO messages (workspace_id, contact_id, email, token, automation_id, step_id, run_id)
       SELECT $1, c.id, c.email, replace(gen_random_uuid()::text, '-', ''), $3, $4, $5 FROM contacts c WHERE c.id = $2
       ON CONFLICT DO NOTHING`,
      [info.workspace_id, run.contact_id, run.automation_id, step.id, run.id]);
    await afterStep(run, step);
  }
}
