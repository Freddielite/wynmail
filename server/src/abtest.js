import { many, one, query } from './db.js';

// One "hour" of waiting. Only tests change this, to decide a winner in seconds.
const HOUR_MS = Number(process.env.AB_HOUR_MS || 3600000);
export const AB_MIN_AUDIENCE = 20;
export const AB_MIN_PER_VARIANT = 5;

// People in each half of the test. At least five each, so a result means something.
export const abPlan = (total, percent) => {
  const per = Math.max(AB_MIN_PER_VARIANT, Math.ceil((total * percent) / 200));
  return { per, test: per * 2, rest: Math.max(0, total - per * 2) };
};

// The winner is whoever got the better rate on the chosen measure. A tie goes to A, the original subject.
export function pickWinner(a, b, metric) {
  const rate = (x) => (x.sent ? (metric === 'clicks' ? x.clicks : x.opens) / x.sent : 0);
  const ra = rate(a), rb = rate(b);
  if (rb > ra) return { winner: 'B', tie: false };
  return { winner: 'A', tie: ra === rb };
}

const empty = () => ({ sent: 0, opens: 0, clicks: 0 });

export async function abStats(campaignId) {
  const rows = await many(
    `SELECT variant, count(*) FILTER (WHERE status = 'sent')::int AS sent,
            count(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opens,
            count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicks
     FROM messages WHERE campaign_id = $1 AND ab_test GROUP BY variant`, [campaignId]);
  const out = { A: empty(), B: empty() };
  for (const r of rows) if (out[r.variant]) out[r.variant] = { sent: r.sent, opens: r.opens, clicks: r.clicks };
  return out;
}

// Once both halves of a test have been sent and the waiting time has passed, the better subject
// goes to everyone who was held back. Claiming the decision with one UPDATE means it happens once.
export async function processAbTests() {
  const running = await many(
    `SELECT * FROM campaigns WHERE status = 'sending' AND subject_b IS NOT NULL AND ab_percent IS NOT NULL AND ab_decided_at IS NULL`);
  for (const c of running) {
    const t = await one(
      `SELECT count(*) FILTER (WHERE status IN ('queued','sending'))::int AS pending, max(sent_at) AS last_sent
       FROM messages WHERE campaign_id = $1 AND ab_test`, [c.id]);
    if (t.pending > 0) continue;
    if (t.last_sent && new Date(t.last_sent).getTime() + (c.ab_wait_hours || 4) * HOUR_MS > Date.now()) continue;
    const stats = await abStats(c.id);
    const { winner, tie } = pickWinner(stats.A, stats.B, c.ab_metric || 'opens');
    const claimed = await one(
      `UPDATE campaigns SET ab_decided_at = now(), ab_winner = $2, ab_result = $3::jsonb
       WHERE id = $1 AND ab_decided_at IS NULL RETURNING id`,
      [c.id, winner, JSON.stringify({ ...stats, metric: c.ab_metric || 'opens', tie })]);
    if (!claimed) continue;
    await query(`UPDATE messages SET status = 'queued', variant = $2 WHERE campaign_id = $1 AND status = 'held'`, [c.id, winner]);
  }
}
