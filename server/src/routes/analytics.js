import { Router } from 'express';
import { many, one } from '../db.js';
import { REASONS } from './track.js';

const router = Router({ mergeParams: true });
const wid = (req) => req.workspace.id;
const num = (v, min, max, fb) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fb; };
// The browser tells us its offset from UTC in minutes so charts show the reader's own day and hour.
const tzOf = (req) => num(req.query.tz, -720, 840, 0);

const rate = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
function summary(r) {
  const sent = Number(r.sent);
  return {
    sent, delivered: Number(r.delivered), opened: Number(r.opened), clicked: Number(r.clicked), bounced: Number(r.bounced),
    complained: Number(r.complained), unsubscribed: Number(r.unsubscribed),
    open_rate: rate(Number(r.opened), sent), click_rate: rate(Number(r.clicked), sent),
    bounce_rate: rate(Number(r.bounced), sent), unsubscribe_rate: rate(Number(r.unsubscribed), sent),
    click_to_open_rate: rate(Number(r.clicked), Number(r.opened))
  };
}
const TOTALS = `count(*) FILTER (WHERE status = 'sent') AS sent, count(delivered_at) AS delivered, count(opened_at) AS opened,
  count(clicked_at) AS clicked, count(bounced_at) AS bounced, count(complained_at) AS complained, count(unsubscribed_at) AS unsubscribed`;

const TOTALS_M = `count(*) FILTER (WHERE m.status = 'sent') AS sent, count(m.delivered_at) AS delivered, count(m.opened_at) AS opened,
  count(m.clicked_at) AS clicked, count(m.bounced_at) AS bounced, count(m.complained_at) AS complained, count(m.unsubscribed_at) AS unsubscribed`;

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

router.get('/overview', async (req, res) => {
  const days = num(req.query.days, 1, 365, 30);
  const tz = tzOf(req);
  const totals = await one(`SELECT ${TOTALS} FROM messages WHERE workspace_id = $1 AND sent_at >= now() - ($2::int * interval '1 day')`, [wid(req), days]);

  // First open and first click per person, grouped by the reader's local day.
  const byDay = async (col) => many(
    `SELECT date_trunc('day', ${col} + $3::int * interval '1 minute')::date AS day, count(*)::int AS n FROM messages
     WHERE workspace_id = $1 AND ${col} >= now() - ($2::int * interval '1 day') GROUP BY 1`, [wid(req), days, tz]);
  const [sent, opened, clicked] = await Promise.all([byDay('sent_at'), byDay('opened_at'), byDay('clicked_at')]);
  const map = { sent: new Map(sent.map((r) => [dayKey(r.day), r.n])), opened: new Map(opened.map((r) => [dayKey(r.day), r.n])), clicked: new Map(clicked.map((r) => [dayKey(r.day), r.n])) };
  const local = new Date(Date.now() + tz * 60000);
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - i));
    const k = dayKey(d);
    series.push({ day: k, sent: map.sent.get(k) || 0, opened: map.opened.get(k) || 0, clicked: map.clicked.get(k) || 0 });
  }

  // When do people open? A 7 by 24 grid of first opens in the reader's local time (0 is Sunday).
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  const opens = await many(
    `SELECT extract(dow FROM opened_at + $3::int * interval '1 minute')::int AS dow, extract(hour FROM opened_at + $3::int * interval '1 minute')::int AS hr, count(*)::int AS n
     FROM messages WHERE workspace_id = $1 AND opened_at >= now() - ($2::int * interval '1 day') GROUP BY 1, 2`, [wid(req), days, tz]);
  for (const o of opens) grid[o.dow][o.hr] = o.n;

  const campaigns = (await many(
    `SELECT c.id, c.name, c.subject, c.finished_at, c.started_at, ${TOTALS_M}
     FROM campaigns c JOIN messages m ON m.campaign_id = c.id
     WHERE c.workspace_id = $1 AND m.sent_at >= now() - ($2::int * interval '1 day') GROUP BY c.id ORDER BY c.id DESC LIMIT 15`, [wid(req), days]
  )).map((r) => ({ id: r.id, name: r.name, subject: r.subject, when: r.finished_at || r.started_at, ...summary(r) }));

  res.json({ days, totals: summary(totals), series, opens_grid: grid, campaigns });
});

// Why people leave, from the short survey shown after unsubscribing. Answers are optional, so the
// totals show how many people answered out of how many left.
router.get('/unsubscribe-reasons', async (req, res) => {
  const days = num(req.query.days, 1, 365, 30);
  const left = (await one(`SELECT count(*)::int AS n FROM events WHERE workspace_id = $1 AND type = 'unsubscribe' AND created_at > now() - interval '1 day' * $2`, [wid(req), days])).n;
  const rows = await many(`SELECT reason, count(*)::int AS n FROM unsub_reasons WHERE workspace_id = $1 AND created_at > now() - interval '1 day' * $2 GROUP BY reason ORDER BY n DESC`, [wid(req), days]);
  const comments = await many(`SELECT reason, comment, created_at FROM unsub_reasons WHERE workspace_id = $1 AND comment IS NOT NULL AND created_at > now() - interval '1 day' * $2 ORDER BY id DESC LIMIT 8`, [wid(req), days]);
  const answered = rows.reduce((a, r) => a + r.n, 0);
  res.json({
    days, unsubscribed: left, answered,
    reasons: rows.map((r) => ({ reason: r.reason, label: REASONS[r.reason] || r.reason, count: r.n })),
    never_signed_up: rows.find((r) => r.reason === 'never_signed_up')?.n || 0,
    comments: comments.map((c) => ({ label: REASONS[c.reason] || c.reason, comment: c.comment, created_at: c.created_at }))
  });
});

router.get('/campaigns/:id', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const id = Number(req.params.id);
  const tz = tzOf(req);
  const c = await one(`SELECT id, name, subject, started_at FROM campaigns WHERE id = $1 AND workspace_id = $2`, [id, wid(req)]);
  if (!c) return res.status(404).json({ error: 'not found' });

  const totals = await one(`SELECT ${TOTALS} FROM messages WHERE campaign_id = $1 AND workspace_id = $2`, [id, wid(req)]);
  const hourly = async (col) => many(
    `SELECT date_trunc('hour', ${col} + $3::int * interval '1 minute') AS at, count(*)::int AS n FROM messages
     WHERE campaign_id = $1 AND workspace_id = $2 AND ${col} IS NOT NULL GROUP BY 1 ORDER BY 1`, [id, wid(req), tz]);
  const [o, k] = await Promise.all([hourly('opened_at'), hourly('clicked_at')]);
  const keyOf = (d) => new Date(d).toISOString().slice(0, 13);
  const times = new Map();
  for (const r of o) times.set(keyOf(r.at), { at: keyOf(r.at), opened: r.n, clicked: 0 });
  for (const r of k) { const t = times.get(keyOf(r.at)) || { at: keyOf(r.at), opened: 0, clicked: 0 }; t.clicked = r.n; times.set(keyOf(r.at), t); }
  const series = [...times.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(0, 96);

  const links = await many(
    `SELECT e.url, count(*)::int AS clicks, count(DISTINCT e.message_id)::int AS people FROM events e
     JOIN messages m ON m.id = e.message_id WHERE m.campaign_id = $1 AND m.workspace_id = $2 AND e.type = 'click' AND e.url IS NOT NULL
     GROUP BY e.url ORDER BY people DESC, clicks DESC LIMIT 15`, [id, wid(req)]);
  const devices = await many(
    `SELECT COALESCE(e.meta ->> 'device', 'unknown') AS device, count(DISTINCT e.message_id)::int AS people FROM events e
     JOIN messages m ON m.id = e.message_id WHERE m.campaign_id = $1 AND m.workspace_id = $2 AND e.type = 'open'
     GROUP BY 1 ORDER BY people DESC`, [id, wid(req)]);

  res.json({ campaign: c, summary: summary(totals), series, links, devices });
});

export default router;
