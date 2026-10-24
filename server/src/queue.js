import { assess, learn } from './spamrisk.js';
import { notify } from './notify.js';
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

// Thrown when a campaign looks too risky and is held for a person to decide. Not a failure.
export class RiskHold extends Error {
  constructor(result) { super('held for review'); this.result = result; }
}

export async function enqueueDueCampaigns() {
  const due = await many(
    `SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= now()`
  );
  for (const { id } of due) {
    try { await enqueueCampaign(id); } catch (err) { if (!(err instanceof RiskHold)) console.error('[queue] enqueue', id, err.message); }
  }
}

// The status change is a single atomic UPDATE, so two simultaneous sends cannot both enqueue.
// force: a person looked at the risk report and chose to send anyway.
export async function enqueueCampaign(campaignId, { force = false, userId = null } = {}) {
  const pre = await one(`SELECT c.id, c.subject, c.html, c.preview_text, c.workspace_id, c.resend_of FROM campaigns c WHERE c.id = $1 AND c.status IN ('draft','scheduled','needs_review')`, [campaignId]);
  if (pre && !force && !pre.resend_of) {
    const workspace = await one(`SELECT * FROM workspaces WHERE id = $1`, [pre.workspace_id]);
    if (workspace.risk_hold_enabled) {
      const result = await assess(workspace, { subject: pre.subject, html: pre.html, preview: pre.preview_text });
      if (result.risk >= workspace.risk_threshold) {
        await query(`UPDATE campaigns SET status = 'needs_review', risk_score = $2, risk_reasons = $3::jsonb WHERE id = $1`, [pre.id, result.risk, JSON.stringify(result.reasons)]);
        await notify(workspace.id, {
          kind: 'risk_hold', campaignId: pre.id, title: 'A campaign was held: it may land in spam',
          body: `Risk ${result.risk} out of 100 (your limit is ${workspace.risk_threshold}). ${result.reasons[0]?.title || ''}. Nothing was sent. Open the campaign to fix it or send it anyway.`
        });
        throw new RiskHold({ held: true, campaign_id: pre.id, ...result, threshold: workspace.risk_threshold });
      }
    }
  }
  const campaign = await one(
    `UPDATE campaigns SET status = 'sending', started_at = now(),
       risk_override_at = CASE WHEN $2::boolean THEN now() ELSE risk_override_at END, risk_override_by = CASE WHEN $2::boolean THEN $3::int ELSE risk_override_by END
     WHERE id = $1 AND status IN ('draft','scheduled','needs_review') RETURNING *`,
    [campaignId, force, userId]
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
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.campaign_id = campaigns.id AND m.status IN ('queued','sending','held','paused'))`
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

// While a campaign is going out, watch what comes back. If many people complain or addresses bounce, stop the rest
// and tell the owner, so a bad email does not keep damaging the sender's reputation.
const COMPLAINT_STOP = Number(process.env.PAUSE_COMPLAINT_RATE || 0.005);
const BOUNCE_STOP = Number(process.env.PAUSE_BOUNCE_RATE || 0.1);
let lastGuard = 0, lastLearn = 0;
export async function guardRunning() {
  if (Date.now() - lastGuard < 60000) return;
  lastGuard = Date.now();
  const rows = await many(
    `SELECT c.id, c.workspace_id, c.name,
            count(m.id) FILTER (WHERE m.sent_at IS NOT NULL)::float AS sent,
            count(m.id) FILTER (WHERE m.complained_at IS NOT NULL)::float AS complained,
            count(m.id) FILTER (WHERE m.bounced_at IS NOT NULL AND m.bounce_type = 'Permanent')::float AS bounced
     FROM campaigns c JOIN messages m ON m.campaign_id = c.id
     WHERE c.status = 'sending' AND c.paused_reason IS NULL GROUP BY c.id`);
  for (const c of rows) {
    if (c.sent < 50) continue;
    const reason = c.complained / c.sent >= COMPLAINT_STOP ? `${(c.complained / c.sent * 100).toFixed(2)}% of recipients marked it as spam`
      : c.bounced / c.sent >= BOUNCE_STOP ? `${(c.bounced / c.sent * 100).toFixed(1)}% of addresses bounced` : null;
    if (!reason) continue;
    const paused = await one(`WITH p AS (UPDATE messages SET status = 'paused' WHERE campaign_id = $1 AND status = 'queued' RETURNING 1)
      SELECT count(*)::int AS n FROM p`, [c.id]);
    await query(`UPDATE campaigns SET paused_reason = $2 WHERE id = $1`, [c.id, reason]);
    await notify(c.workspace_id, { kind: 'paused', campaignId: c.id, title: `Sending paused: ${c.name}`,
      body: `${reason}. ${paused.n} emails were not sent yet. Check the email and your list, then resume or leave it stopped.` });
  }
  // Learning runs hourly on whichever server gets there first.
  if (Date.now() - lastLearn > 3600000) { lastLearn = Date.now(); await learn().catch((err) => console.error('[learn]', err.message)); }
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
      await guardRunning();
    } catch (err) {
      console.error('[queue]', err.message);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, TICK_MS);
}
