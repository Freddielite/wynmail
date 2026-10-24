import { one, many, query } from './db.js';

export const RETENTION_DAYS = Number(process.env.DELETED_RETENTION_DAYS || 30);

// Keeps a copy of a deleted row for the undo window, so "I deleted it by accident" is a restore, not an incident.
export async function archive(workspaceId, kind, row, { label, userId, extra = {} } = {}) {
  await query(
    `INSERT INTO deleted_records (workspace_id, kind, label, data, deleted_by, purge_after)
     VALUES ($1, $2, $3, $4::jsonb, $5, now() + ($6 || ' days')::interval)`,
    [workspaceId, kind, String(label ?? '').slice(0, 200), JSON.stringify({ row, ...extra }), userId ?? null, String(RETENTION_DAYS)]);
}

export const listDeleted = (workspaceId) => many(
  `SELECT id, kind, label, deleted_at, purge_after FROM deleted_records WHERE workspace_id = $1 AND purge_after > now() ORDER BY id DESC LIMIT 200`, [workspaceId]);

const TABLES = { template: 'templates', list: 'lists', contact: 'contacts' };
export const kindOf = async (workspaceId, id) => (await one(`SELECT kind FROM deleted_records WHERE id = $1 AND workspace_id = $2 AND purge_after > now()`, [id, workspaceId]))?.kind || null;

// Puts a deleted template, list or contact back. Returns the restored row, null when it is gone,
// or { conflict } when a contact with that address was added again in the meantime.
export async function restore(workspaceId, id) {
  const rec = await one(`SELECT * FROM deleted_records WHERE id = $1 AND workspace_id = $2 AND purge_after > now()`, [id, workspaceId]);
  if (!rec) return null;
  const { row, list_contact_ids, list_ids } = rec.data;
  const table = TABLES[rec.kind];
  if (!table || !row || row.workspace_id !== workspaceId) return null;
  if (rec.kind === 'contact' && await one(`SELECT 1 FROM contacts WHERE workspace_id = $1 AND email = $2`, [workspaceId, row.email])) {
    return { conflict: 'This address was added again after it was deleted, so it cannot be restored.' };
  }
  // Same id back if it is free, a new one if not.
  const taken = await one(`SELECT 1 FROM ${table} WHERE id = $1`, [row.id]);
  const cols = Object.keys(row).filter((k) => /^\w+$/.test(k) && (!taken || k !== 'id'));
  const restored = await one(
    `INSERT INTO ${table} (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM jsonb_populate_record(NULL::${table}, $1::jsonb) RETURNING *`,
    [JSON.stringify(row)]);
  if (restored && rec.kind === 'list' && Array.isArray(list_contact_ids) && list_contact_ids.length) {
    await query(
      `INSERT INTO list_contacts (list_id, contact_id) SELECT $1, c.id FROM contacts c WHERE c.workspace_id = $2 AND c.id = ANY($3::int[]) ON CONFLICT DO NOTHING`,
      [restored.id, workspaceId, list_contact_ids]);
  }
  if (restored && rec.kind === 'contact' && Array.isArray(list_ids) && list_ids.length) {
    await query(
      `INSERT INTO list_contacts (list_id, contact_id) SELECT l.id, $1 FROM lists l WHERE l.workspace_id = $2 AND l.id = ANY($3::int[]) ON CONFLICT DO NOTHING`,
      [restored.id, workspaceId, list_ids]);
  }
  await query(`DELETE FROM deleted_records WHERE id = $1`, [id]);
  return restored;
}

// Erases a held record for good, including the signup log of a contact. Used for privacy requests.
export async function eraseNow(workspaceId, id) {
  const rec = await one(`DELETE FROM deleted_records WHERE id = $1 AND workspace_id = $2 RETURNING kind, data`, [id, workspaceId]);
  if (!rec) return false;
  if (rec.kind === 'contact') {
    await query(`DELETE FROM form_signups WHERE workspace_id = $1 AND email = $2`, [workspaceId, rec.data?.row?.email]);
  }
  return true;
}
