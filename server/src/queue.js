import { many, one, query } from './db.js';
import { getProvider } from './providers/index.js';
import { buildEmail } from './render.js';
import { decrypt } from './config.js';
import { senderAllowed } from './validate.js';

const MAX_ATTEMPTS = 3;
const TICK_MS = Number(process.env.QUEUE_TICK_MS || 5000);
// Pause between sends so the shared provider key stays under the provider's requests-per-second limit.
const SEND_GAP_MS = Number(process.env.SEND_GAP_MS || 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;

export async function enqueueDueCampaigns() {
  const due = await many(
    `SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= now()`
  );
  for (const { id } of due) {
    try { await enqueueCampaign(id); } catch (err) { console.error('[queue] enqueue', id, err.message); }
  }
}

// The status change is a single atomic UPDATE, so two simultaneous sends cannot both enqueue.
export async function enqueueCampaign(campaignId) {
  const campaign = await one(
    `UPDATE campaigns SET status = 'sending', started_at = now()
     WHERE id = $1 AND status IN ('draft','scheduled') RETURNING *`,
    [campaignId]
  );
  if (!campaign) throw new Error('campaign not found or already sent');

  try {
    const res = await one(
      `WITH ins AS (
         INSERT INTO messages (workspace_id, campaign_id, contact_id, email, token)
         SELECT $2, $1, c.id, c.email, replace(gen_random_uuid()::text, '-', '')
         FROM contacts c
         JOIN list_contacts lc ON lc.contact_id = c.id
         JOIN lists l ON l.id = lc.list_id AND l.workspace_id = c.workspace_id
         WHERE lc.list_id = $3 AND c.status = 'subscribed' AND c.workspace_id = $2
         RETURNING 1
       ) SELECT count(*)::int AS n FROM ins`,
      [campaign.id, campaign.workspace_id, campaign.list_id]
    );
    if (!res.n) throw new Error('this list has no subscribed contacts');
    return res.n;
  } catch (err) {
    await query(`UPDATE campaigns SET status = 'draft', started_at = NULL WHERE id = $1`, [campaign.id]);
    throw err;
  }
}

async function sentToday(workspaceId) {
  const row = await one(
    `SELECT count(*)::int AS n FROM messages WHERE workspace_id = $1 AND sent_at >= date_trunc('day', now())`,
    [workspaceId]
  );
  return row?.n || 0;
}

export async function drainOnce() {
  await query(`UPDATE messages SET status = 'queued' WHERE status = 'sending' AND claimed_at < now() - interval '10 minutes'`);

  const workspaces = await many(
    `SELECT DISTINCT w.* FROM workspaces w JOIN messages m ON m.workspace_id = w.id WHERE m.status = 'queued'`
  );

  for (const workspace of workspaces) {
    const dailyLeft = Math.max(0, (workspace.daily_limit || 0) - (await sentToday(workspace.id)));
    // rate_per_minute is per minute, so scale it down to the size of one tick.
    const perTick = Math.max(1, Math.ceil(((workspace.rate_per_minute || 60) * TICK_MS) / 60000));
    const batchSize = Math.min(perTick, dailyLeft);
    if (batchSize <= 0) continue;

    // Claim rows atomically so an overlapping tick or second instance never double-sends.
    const batch = await many(
      `UPDATE messages SET status = 'sending', claimed_at = now()
       WHERE id IN (
         SELECT id FROM messages WHERE workspace_id = $1 AND status = 'queued'
         ORDER BY queued_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
      [workspace.id, batchSize]
    );
    for (const message of batch) {
      await sendMessage(workspace, message);
      await sleep(SEND_GAP_MS);
    }
  }

  await query(
    `UPDATE campaigns SET status = 'sent', finished_at = now()
     WHERE status = 'sending'
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.campaign_id = campaigns.id AND m.status IN ('queued','sending'))`
  );
}

async function sendMessage(workspace, message) {
  const contact = await one(`SELECT * FROM contacts WHERE id = $1`, [message.contact_id]);
  const campaign = await one(`SELECT * FROM campaigns WHERE id = $1`, [message.campaign_id]);
  if (!contact || !campaign || contact.status !== 'subscribed') {
    await query(`UPDATE messages SET status = 'skipped' WHERE id = $1`, [message.id]);
    return;
  }
  if (!senderAllowed(workspace)) {
    await query(`UPDATE messages SET status = 'failed', error = $2 WHERE id = $1`,
      [message.id, 'sender domain not approved']);
    return;
  }

  try {
    const built = buildEmail({ workspace, contact, subject: campaign.subject, html: campaign.html, token: message.token });
    const result = await getProvider(workspace).send({
      to: contact.email,
      from: `${workspace.from_name || workspace.name} <${workspace.from_email}>`,
      replyTo: workspace.reply_to || undefined,
      apiKey: decrypt(workspace.provider_api_key) || undefined,
      ...built
    });
    await query(
      `UPDATE messages SET status = 'sent', sent_at = now(), provider_id = $2, attempts = attempts + 1 WHERE id = $1`,
      [message.id, result.id || null]
    );
    await query(`INSERT INTO events (workspace_id, message_id, type) VALUES ($1, $2, 'sent')`, [workspace.id, message.id]);
  } catch (err) {
    const attempts = message.attempts + 1;
    await query(
      `UPDATE messages SET status = $2, attempts = $3, error = $4 WHERE id = $1`,
      [message.id, attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', attempts, String(err.message).slice(0, 500)]
    );
  }
}

export function startWorker() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await enqueueDueCampaigns();
      await drainOnce();
    } catch (err) {
      console.error('[queue]', err.message);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, TICK_MS);
}
