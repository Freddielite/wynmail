import { one, many, query } from './db.js';
import { encrypt } from './config.js';
import { imapHostFor } from './imaphost.js';

// A workspace can send through several normal mailboxes (Zoho Mail, Google Workspace). Each has its own daily cap,
// and sends rotate: the mailbox used least recently, with room left today, goes next.

export const CAP_MIN = 1, CAP_MAX = 500, DEFAULT_CAP = 30;
const TODAY = `(now() AT TIME ZONE 'UTC')::date`;

const PUBLIC = `id, workspace_id, label, host, port, username, from_email, daily_cap, enabled, last_used_at, last_error, last_error_at, verified_at, created_at, imap_host, watch_replies, imap_checked_at, imap_error,
  CASE WHEN sent_day = ${TODAY} THEN sent_today ELSE 0 END AS sent_today,
  GREATEST(0, daily_cap - CASE WHEN sent_day = ${TODAY} THEN sent_today ELSE 0 END) AS left_today`;

export const listMailboxes = (workspaceId) => many(`SELECT ${PUBLIC} FROM mailboxes WHERE workspace_id = $1 ORDER BY id`, [workspaceId]);

export async function createMailbox(workspaceId, m) {
  return one(
    `INSERT INTO mailboxes (workspace_id, label, host, port, username, password_enc, from_email, daily_cap, verified_at, imap_host, watch_replies)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10) RETURNING ${PUBLIC}`,
    [workspaceId, m.label, m.host, m.port, m.username, encrypt(m.password), m.from_email, m.daily_cap, m.imap_host ?? imapHostFor(m.host), m.watch_replies !== false]);
}

export async function updateMailbox(workspaceId, id, m) {
  return one(
    `UPDATE mailboxes SET label = COALESCE($3, label), host = COALESCE($4, host), port = COALESCE($5, port), username = COALESCE($6, username),
       password_enc = COALESCE($7, password_enc), from_email = COALESCE($8, from_email), daily_cap = COALESCE($9, daily_cap),
       enabled = COALESCE($10::boolean, enabled),
       imap_host = COALESCE($12, imap_host), watch_replies = COALESCE($13::boolean, watch_replies),
       imap_error = CASE WHEN $12 IS NOT NULL OR $7 IS NOT NULL OR $13::boolean IS TRUE THEN NULL ELSE imap_error END,
       imap_last_uid = CASE WHEN $12 IS NOT NULL THEN NULL ELSE imap_last_uid END,
       last_error = CASE WHEN $10::boolean IS TRUE OR $7 IS NOT NULL THEN NULL ELSE last_error END,
       verified_at = CASE WHEN $11::boolean THEN now() ELSE verified_at END
     WHERE id = $1 AND workspace_id = $2 RETURNING ${PUBLIC}`,
    [id, workspaceId, m.label ?? null, m.host ?? null, m.port ?? null, m.username ?? null, m.password ? encrypt(m.password) : null,
     m.from_email ?? null, m.daily_cap ?? null, typeof m.enabled === 'boolean' ? m.enabled : null, !!m.verified,
     m.imap_host ?? null, typeof m.watch_replies === 'boolean' ? m.watch_replies : null]);
}

export const deleteMailbox = (workspaceId, id) => one(`DELETE FROM mailboxes WHERE id = $1 AND workspace_id = $2 RETURNING id`, [id, workspaceId]);

// Takes one sending slot from the next mailbox in the rotation, in one statement, so two servers never overspend a cap.
export async function claimMailbox(workspaceId) {
  return one(
    `UPDATE mailboxes SET sent_today = CASE WHEN sent_day = ${TODAY} THEN sent_today + 1 ELSE 1 END, sent_day = ${TODAY}, last_used_at = now()
     WHERE id = (SELECT id FROM mailboxes WHERE workspace_id = $1 AND enabled AND (sent_day IS DISTINCT FROM ${TODAY} OR sent_today < daily_cap)
                 ORDER BY last_used_at NULLS FIRST, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [workspaceId]);
}

// Same as claimMailbox but for one chosen mailbox (the "send me a test" button). Still obeys the cap.
export async function claimSpecific(workspaceId, id) {
  return one(
    `UPDATE mailboxes SET sent_today = CASE WHEN sent_day = ${TODAY} THEN sent_today + 1 ELSE 1 END, sent_day = ${TODAY}, last_used_at = now()
     WHERE id = $1 AND workspace_id = $2 AND (sent_day IS DISTINCT FROM ${TODAY} OR sent_today < daily_cap) RETURNING *`, [id, workspaceId]);
}

// A send that failed before reaching the mailbox's server gives its slot back.
export const releaseSlot = (id) => query(`UPDATE mailboxes SET sent_today = GREATEST(0, sent_today - 1) WHERE id = $1 AND sent_day = ${TODAY}`, [id]);

export async function recordFailure(id, message, { disable = false } = {}) {
  await query(`UPDATE mailboxes SET last_error = $2, last_error_at = now(), enabled = CASE WHEN $3::boolean THEN false ELSE enabled END WHERE id = $1`, [id, String(message).slice(0, 300), disable]);
}
export const recordSuccess = (id) => query(`UPDATE mailboxes SET last_error = NULL WHERE id = $1 AND last_error IS NOT NULL`, [id]);

// How many more emails the workspace can send today across all its mailboxes.
export async function capacity(workspaceId) {
  const r = await one(
    `SELECT count(*)::int AS boxes, COALESCE(sum(GREATEST(0, daily_cap - CASE WHEN sent_day = ${TODAY} THEN sent_today ELSE 0 END)), 0)::int AS left
     FROM mailboxes WHERE workspace_id = $1 AND enabled`, [workspaceId]);
  return { boxes: r.boxes, left: r.left };
}
