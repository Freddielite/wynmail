import { one, many, query } from './db.js';
import { startManual } from './automations.js';
import { capacity } from './mailboxes.js';

// Cold outreach on top of the automation engine: a "started by me" sequence of up to 3 emails, started in small daily
// batches from the Prospects list. Replies and removal requests stop it (see replies.js and queue.js).

const STARTER = [
  { delay: 0, subject: 'A quick idea for {{company|your business}}', html: `<p>Hi {{first_name|there}},</p>
<p>[EDIT: one sentence about something real you noticed on {{company|their}} website.]</p>
<p>[EDIT: one sentence on what Wyntek does for businesses like theirs, and a result.]</p>
<p>Would a quick chat this week be useful? Just reply to this email.</p>
<p>[EDIT: your name]<br>Wyntek Technologies</p>` },
  { delay: 3 * 1440, subject: 'Following up', html: `<p>Hi {{first_name|there}},</p>
<p>I wrote a few days ago about [EDIT: the idea in a few words]. In case it got buried: [EDIT: one line with the offer or benefit].</p>
<p>If it is useful, reply and I will send details.</p>
<p>[EDIT: your name]<br>Wyntek Technologies</p>` },
  { delay: 4 * 1440, subject: 'Last note from me', html: `<p>Hi {{first_name|there}},</p>
<p>I do not want to fill your inbox, so this is my last email. If [EDIT: the offer in a few words] is ever useful, just reply.</p>
<p>If it is not for you, no problem at all: reply "no thanks" and I will not write again.</p>
<p>[EDIT: your name]<br>Wyntek Technologies</p>` }
];

// A paused 3-email sequence with starter copy. It is paused and full of [EDIT] markers on purpose: nothing can be sent until it is written.
export async function createStarter(workspaceId) {
  const a = await one(`INSERT INTO automations (workspace_id, name, status, include_imports, trigger_type, goal_type, goal_value) VALUES ($1, 'Cold outreach (3 emails)', 'paused', true, 'manual', 'replied', '1') RETURNING *`, [workspaceId]);
  for (const [i, s] of STARTER.entries()) {
    await query(`INSERT INTO automation_steps (automation_id, position, delay_minutes, kind, subject, html) VALUES ($1, $2, $3, 'email', $4, $5)`, [a.id, i, s.delay, s.subject, s.html]);
  }
  return a;
}

export const hasPlaceholders = async (automationId) =>
  !!(await one(`SELECT 1 FROM automation_steps WHERE automation_id = $1 AND kind = 'email' AND (subject LIKE '%[EDIT%' OR html LIKE '%[EDIT%') LIMIT 1`, [automationId]));

export async function listSequences(workspaceId) {
  return many(
    `SELECT a.id, a.name, a.status,
       (SELECT count(*)::int FROM automation_steps s WHERE s.automation_id = a.id AND s.kind = 'email') AS emails,
       (SELECT count(*)::int FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'active') AS in_progress,
       EXISTS (SELECT 1 FROM automation_steps s WHERE s.automation_id = a.id AND s.kind = 'email' AND (s.subject LIKE '%[EDIT%' OR s.html LIKE '%[EDIT%')) AS needs_editing
     FROM automations a WHERE a.workspace_id = $1 AND a.trigger_type = 'manual' ORDER BY a.id DESC`, [workspaceId]);
}

// Where the prospects stand right now.
export async function outreachStats(workspaceId) {
  const r = await one(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE c.status = 'subscribed' AND c.replied_at IS NULL AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.status IN ('sent', 'queued', 'sending')))::int AS not_contacted,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM automation_runs r WHERE r.contact_id = c.id AND r.status = 'active'))::int AS in_sequence,
       count(*) FILTER (WHERE c.replied_at IS NOT NULL)::int AS replied,
       count(*) FILTER (WHERE c.status = 'bounced')::int AS bounced,
       count(*) FILTER (WHERE c.status IN ('unsubscribed', 'complained'))::int AS removed,
       count(*) FILTER (WHERE c.replied_at IS NULL AND c.status = 'subscribed' AND (SELECT count(*) FROM messages m WHERE m.contact_id = c.id AND m.status = 'sent') >= 3)::int AS no_answer
     FROM contacts c WHERE c.workspace_id = $1 AND c.consent_source = 'prospector'`, [workspaceId]);
  return { ...r, capacity_left: (await capacity(workspaceId)).left };
}

export async function startOutreach(workspaceId, automationId, count) {
  const a = await one(`SELECT * FROM automations WHERE id = $1 AND workspace_id = $2 AND trigger_type = 'manual'`, [automationId, workspaceId]);
  if (!a) throw Object.assign(new Error('Choose one of your outreach sequences'), { status: 404 });
  if (a.status !== 'active') throw Object.assign(new Error('Switch the sequence on first (Automations)'), { status: 400 });
  if (await hasPlaceholders(a.id)) throw Object.assign(new Error('The sequence still has [EDIT] notes in it. Write your own emails first (Automations).'), { status: 400 });
  const n = Math.min(Math.max(Math.floor(Number(count) || 0), 1), 200);
  return { started: await startManual(workspaceId, a.id, n) };
}
