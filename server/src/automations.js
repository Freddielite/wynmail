import { many, one, query } from './db.js';

// How long one "minute" of delay lasts. Only tests change this, to run sequences in seconds.
const MINUTE_MS = Number(process.env.AUTOMATION_MINUTE_MS || 60000);

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
     JOIN automation_steps s ON s.automation_id = a.id AND s.position = 0
     WHERE a.workspace_id = $1 AND a.status = 'active' AND a.list_id = ANY($3::int[])
       AND ($4::boolean OR a.include_imports)
     ON CONFLICT (automation_id, contact_id) DO NOTHING`,
    [workspaceId, contactId, listIds, source !== 'import', MINUTE_MS]
  );
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
      `SELECT a.workspace_id, c.status AS contact_status FROM automations a, contacts c WHERE a.id = $1 AND c.id = $2`,
      [run.automation_id, run.contact_id]);
    if (!info || info.contact_status !== 'subscribed') {
      await query(`UPDATE automation_runs SET status = 'cancelled', next_at = NULL WHERE id = $1`, [run.id]);
      continue;
    }
    const step = await one(`SELECT id FROM automation_steps WHERE automation_id = $1 AND position = $2`, [run.automation_id, run.current_step]);
    if (!step) {
      await query(`UPDATE automation_runs SET status = 'completed', completed_at = now(), next_at = NULL WHERE id = $1`, [run.id]);
      continue;
    }
    await query(
      `INSERT INTO messages (workspace_id, contact_id, email, token, automation_id, step_id, run_id)
       SELECT $1, c.id, c.email, replace(gen_random_uuid()::text, '-', ''), $3, $4, $5 FROM contacts c WHERE c.id = $2
       ON CONFLICT DO NOTHING`,
      [info.workspace_id, run.contact_id, run.automation_id, step.id, run.id]);

    const next = await one(`SELECT delay_minutes FROM automation_steps WHERE automation_id = $1 AND position = $2`, [run.automation_id, run.current_step + 1]);
    if (next) {
      await query(
        `UPDATE automation_runs SET current_step = current_step + 1, next_at = now() + interval '1 millisecond' * ($2::int * $3::int) WHERE id = $1`,
        [run.id, next.delay_minutes, MINUTE_MS]);
    } else {
      await query(`UPDATE automation_runs SET status = 'completed', completed_at = now(), current_step = current_step + 1, next_at = NULL WHERE id = $1`, [run.id]);
    }
  }
}
