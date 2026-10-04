import { one } from './db.js';
import { warmupLimit } from './warmup.js';

// Everything a workspace sent today, campaigns plus API and test emails. One number, one daily cap.
export async function sentToday(workspaceId) {
  const row = await one(
    `SELECT ((SELECT count(*) FROM messages WHERE workspace_id = $1 AND sent_at >= date_trunc('day', now()))
           + (SELECT count(*) FROM api_emails WHERE workspace_id = $1 AND status = 'sent' AND created_at >= date_trunc('day', now())))::int AS n`,
    [workspaceId]
  );
  return row.n;
}

// How yesterday went, for the warm-up health check. Counts only campaign and automation mail.
export async function yesterdayStats(workspaceId) {
  return one(
    `SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent,
            count(*) FILTER (WHERE bounce_type = 'Permanent')::int AS bounced,
            count(*) FILTER (WHERE complained_at IS NOT NULL)::int AS complained
     FROM messages WHERE workspace_id = $1 AND sent_at >= date_trunc('day', now()) - interval '1 day' AND sent_at < date_trunc('day', now())`,
    [workspaceId]
  );
}

// The daily limit that applies to the campaign queue: the plain limit, or the warm-up cap while warming up.
export async function campaignLimit(ws) {
  if (!ws.warmup_enabled || !ws.warmup_started_at) return warmupLimit(ws, null);
  return warmupLimit(ws, await yesterdayStats(ws.id));
}
