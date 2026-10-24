import { query, many } from './db.js';

// Keys that must never reach the log, whatever a caller passes.
const SECRET_KEY = /pass|token|secret|authorization|api_?key|card|cookie/i;
const clean = (v, depth = 0) => {
  if (depth > 3 || v === null || v === undefined) return v ?? null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[redacted]' : clean(x, depth + 1)]));
  return typeof v === 'string' ? v.slice(0, 300) : v;
};

// Who did what, from where. Never throws: a failed audit write must not break the request.
export async function audit(req, action, { workspaceId = null, actorId, target = null, meta = {} } = {}) {
  try {
    await query(
      `INSERT INTO audit_log (workspace_id, actor_user_id, action, target, ip, meta) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [workspaceId ?? req.workspace?.id ?? null, actorId ?? req.user?.uid ?? null, action, target === null ? null : String(target).slice(0, 200),
       String(req.ip || '').slice(0, 64), JSON.stringify(clean(meta))]
    );
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'audit write failed', action, err: err.message }));
  }
}

export async function listAudit(workspaceId, { before, limit = 100 } = {}) {
  const params = [workspaceId, Math.min(Math.max(Number(limit) || 100, 1), 200)];
  let cursor = '';
  if (/^\d{1,18}$/.test(String(before || ''))) { params.push(before); cursor = `AND a.id < $3`; }
  return many(
    `SELECT a.id, a.action, a.target, a.ip, a.meta, a.created_at, u.email AS actor_email
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.workspace_id = $1 ${cursor} ORDER BY a.id DESC LIMIT $2`, params);
}
