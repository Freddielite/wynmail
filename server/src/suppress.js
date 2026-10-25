import { query } from './db.js';

// Never override an unsubscribe, and let a complaint upgrade an earlier bounce.
export async function suppress(workspaceId, email, reason) {
  await query(
    `INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, email) DO UPDATE SET
       reason = CASE WHEN suppressions.reason = 'complained' THEN 'complained' ELSE EXCLUDED.reason END`,
    [workspaceId, email, reason]
  );
  // Never override an unsubscribe, and let a complaint upgrade an earlier bounce.
  await query(
    `UPDATE contacts SET status = $3 WHERE workspace_id = $1 AND email = $2
     AND (status = 'subscribed' OR (status = 'bounced' AND $3 = 'complained'))`,
    [workspaceId, email, reason]
  );
}
