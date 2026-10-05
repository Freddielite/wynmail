import { many, one, query } from './db.js';
import { getProvider } from './providers/index.js';
import { buildEmail } from './render.js';
import { decrypt } from './config.js';
import { senderAllowed } from './validate.js';
import { throttled } from './throttle.js';
import { sentToday, campaignLimit } from './usage.js';
import { processDueRuns, scanDateTriggers } from './automations.js';
import { compileSegment } from './segments.js';
import { processAbTests, abPlan, AB_MIN_AUDIENCE } from './abtest.js';
import { applyBestTime, applyLocalTime } from './timing.js';

const MAX_ATTEMPTS = 3;
const TICK_MS = Number(process.env.QUEUE_TICK_MS || 5000);
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

  // Campaigns that wait for a test result or for timed delivery are inserted on hold. Nothing can leave
  // until the plan is complete, and a failure cleans up after itself.
  const ab = !!(campaign.subject_b && campaign.ab_percent);
  const staged = ab || campaign.best_time || campaign.local_time;
  const initial = staged ? 'held' : 'queued';

  try {
    let res;
    if (campaign.resend_of) {
      // Everyone who got the first email, is still subscribed, and has not opened, clicked, bounced or complained.
      res = await one(
        `WITH ins AS (
           INSERT INTO messages (workspace_id, campaign_id, contact_id, email, token, status)
           SELECT $2, $1, c.id, c.email, replace(gen_random_uuid()::text, '-', ''), '${initial}'
           FROM messages m JOIN contacts c ON c.id = m.contact_id AND c.workspace_id = $2
           WHERE m.campaign_id = $3 AND m.workspace_id = $2 AND m.status = 'sent'
             AND m.opened_at IS NULL AND m.clicked_at IS NULL AND m.bounced_at IS NULL AND m.complained_at IS NULL
             AND m.unsubscribed_at IS NULL AND c.status = 'subscribed'
           RETURNING 1
         ) SELECT count(*)::int AS n FROM ins`, [campaign.id, campaign.workspace_id, campaign.resend_of]);
    } else if (campaign.segment_id) {
      // A segment is worked out now, at send time, so it always reflects who matches today.
      const seg = await one(`SELECT definition FROM segments WHERE id = $1 AND workspace_id = $2`, [campaign.segment_id, campaign.workspace_id]);
      if (!seg) throw new Error('the segment for this campaign no longer exists');
      const params = [campaign.id, campaign.workspace_id];
      const cond = compileSegment(seg.definition, params);
      res = await one(
        `WITH ins AS (
           INSERT INTO messages (workspace_id, campaign_id, contact_id, email, token, status)
           SELECT $2, $1, c.id, c.email, replace(gen_random_uuid()::text, '-', ''), '${initial}'
           FROM contacts c WHERE c.workspace_id = $2 AND c.status = 'subscribed' AND ${cond}
           RETURNING 1
         ) SELECT count(*)::int AS n FROM ins`, params);
    } else {
      res = await one(
        `WITH ins AS (
           INSERT INTO messages (workspace_id, campaign_id, contact_id, email, token, status)
           SELECT $2, $1, c.id, c.email, replace(gen_random_uuid()::text, '-', ''), '${initial}'
           FROM contacts c
           JOIN list_contacts lc ON lc.contact_id = c.id
           JOIN lists l ON l.id = lc.list_id AND l.workspace_id = c.workspace_id
           WHERE lc.list_id = $3 AND c.status = 'subscribed' AND c.workspace_id = $2
           RETURNING 1
         ) SELECT count(*)::int AS n FROM ins`,
        [campaign.id, campaign.workspace_id, campaign.list_id]);
    }
    if (!res.n) throw new Error(campaign.resend_of ? 'everyone who got the first email has opened it, clicked, or left' : 'there is no one subscribed to send this to');

    if (ab) {
      if (res.n < AB_MIN_AUDIENCE) throw new Error(`An A/B test needs at least ${AB_MIN_AUDIENCE} people to mean anything. This audience has ${res.n}. Turn the test off or choose a bigger audience.`);
      const { test } = abPlan(res.n, campaign.ab_percent);
      // A random test group, split evenly. Everyone else waits for the winner.
      await query(
        `WITH ranked AS (SELECT id, row_number() OVER (ORDER BY random()) AS rn FROM messages WHERE campaign_id = $1)
         UPDATE messages m SET status = 'queued', ab_test = true, variant = CASE WHEN r.rn % 2 = 1 THEN 'A' ELSE 'B' END
         FROM ranked r WHERE m.id = r.id AND r.rn <= $2`, [campaign.id, test]);
    } else if (campaign.best_time) {
      await applyBestTime(campaign);
      await query(`UPDATE messages SET status = 'queued' WHERE campaign_id = $1 AND status = 'held'`, [campaign.id]);
    } else if (campaign.local_time) {
      const ws = await one(`SELECT default_timezone FROM workspaces WHERE id = $1`, [campaign.workspace_id]);
      await applyLocalTime(campaign, ws?.default_timezone);
      await query(`UPDATE messages SET status = 'queued' WHERE campaign_id = $1 AND status = 'held'`, [campaign.id]);
    }
    return res.n;
  } catch (err) {
    await query(`DELETE FROM messages WHERE campaign_id = $1 AND status = 'held'`, [campaign.id]);
    await query(`UPDATE campaigns SET status = 'draft', started_at = NULL WHERE id = $1`, [campaign.id]);
    throw err;
  }
}

export async function drainOnce() {
  await query(`UPDATE messages SET status = 'queued' WHERE status = 'sending' AND claimed_at < now() - interval '10 minutes'`);

  const workspaces = await many(
    `SELECT DISTINCT w.* FROM workspaces w JOIN messages m ON m.workspace_id = w.id WHERE m.status = 'queued' AND (m.send_after IS NULL OR m.send_after <= now())`
  );

  for (const workspace of workspaces) {
    // While warming up, the cap grows day by day. Transactional mail is not held back by it.
    const lim = await campaignLimit(workspace);
    const dailyLeft = Math.max(0, lim.limit - (await sentToday(workspace.id)));
    // rate_per_minute is per minute, so scale it down to the size of one tick.
    const perTick = Math.max(1, Math.ceil(((workspace.rate_per_minute || 60) * TICK_MS) / 60000));
    const batchSize = Math.min(perTick, dailyLeft);
    if (batchSize <= 0) continue;

    // Claim rows atomically so an overlapping tick or second instance never double-sends.
    const batch = await many(
      `UPDATE messages SET status = 'sending', claimed_at = now()
       WHERE id IN (
         SELECT id FROM messages WHERE workspace_id = $1 AND status = 'queued' AND (send_after IS NULL OR send_after <= now())
         ORDER BY queued_at ASC,
           CASE WHEN $3::boolean THEN (SELECT count(*) FROM messages p WHERE p.contact_id = messages.contact_id AND p.opened_at IS NOT NULL) ELSE 0 END DESC,
           id ASC
         LIMIT $2 FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
      // While warming up, the most engaged people go first, which builds a good reputation fastest.
      [workspace.id, batchSize, lim.active]
    );
    for (const message of batch) await throttled(() => sendMessage(workspace, message));
  }

  await query(
    `UPDATE campaigns SET status = 'sent', finished_at = now()
     WHERE status = 'sending'
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.campaign_id = campaigns.id AND m.status IN ('queued','sending','held'))`
  );
}

async function sendMessage(workspace, message) {
  const contact = await one(`SELECT * FROM contacts WHERE id = $1`, [message.contact_id]);
  const campaign = message.campaign_id
    ? await one(`SELECT * FROM campaigns WHERE id = $1`, [message.campaign_id])
    : await one(`SELECT * FROM automation_steps WHERE id = $1`, [message.step_id]);
  if (!contact || !campaign || contact.status !== 'subscribed') {
    await query(`UPDATE messages SET status = 'skipped' WHERE id = $1`, [message.id]);
    return;
  }
  // Preferences set on the preference page: a pause, or a cap on emails per week.
  if (contact.paused_until && new Date(contact.paused_until) > new Date()) {
    await query(`UPDATE messages SET status = 'skipped', error = 'Skipped: this person paused emails' WHERE id = $1`, [message.id]);
    return;
  }
  if (contact.max_per_week) {
    const recent = await one(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND status = 'sent' AND sent_at > now() - interval '7 days'`, [contact.id]);
    if (recent.n >= contact.max_per_week) {
      await query(`UPDATE messages SET status = 'skipped', error = 'Skipped: this person limits emails per week' WHERE id = $1`, [message.id]);
      return;
    }
  }
  if (!senderAllowed(workspace)) {
    await query(`UPDATE messages SET status = 'failed', error = $2 WHERE id = $1`,
      [message.id, 'sender domain not approved']);
    return;
  }

  try {
    // The B half of an A/B test gets the second subject. Everyone else gets the main one.
    const subject = message.variant === 'B' && campaign.subject_b ? campaign.subject_b : campaign.subject;
    const built = buildEmail({ workspace, contact, subject, html: campaign.html, token: message.token, preheader: campaign.preview_text });
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
      await processDueRuns();
      await scanDateTriggers();
      await processAbTests();
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
