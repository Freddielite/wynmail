import { one } from './db.js';

// Everything a workspace sent today, campaigns plus API and test emails. One number, one daily cap.
export async function sentToday(workspaceId) {
  const row = await one(
    `SELECT ((SELECT count(*) FROM messages WHERE workspace_id = $1 AND sent_at >= date_trunc('day', now()))
           + (SELECT count(*) FROM api_emails WHERE workspace_id = $1 AND status = 'sent' AND created_at >= date_trunc('day', now())))::int AS n`,
    [workspaceId]
  );
  return row.n;
}
