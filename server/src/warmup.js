// Warm-up: a new sending domain has no reputation, so volume grows a little each day instead of
// jumping to the full daily limit. Day 1 sends `warmup_start_volume`, each next day sends `warmup_growth` times more.
const DAY = 86400000;
const utcDay = (d) => Math.floor(new Date(d).getTime() / DAY);

export const warmupDay = (ws, now = new Date()) =>
  ws.warmup_enabled && ws.warmup_started_at ? Math.max(1, utcDay(now) - utcDay(ws.warmup_started_at) + 1) : null;

export function capForDay(ws, day) {
  const start = Math.max(1, Number(ws.warmup_start_volume) || 50);
  const growth = Math.min(3, Math.max(1.1, Number(ws.warmup_growth) || 1.6));
  return Math.ceil(start * growth ** (day - 1));
}

// Growth pauses when yesterday looked unhealthy: do not send more than yesterday until it recovers.
export function healthHold(y) {
  if (!y || y.sent < 50) return null;
  if (y.complained / y.sent > 0.003) return `Yesterday ${((y.complained / y.sent) * 100).toFixed(2)}% of emails were reported as spam`;
  if (y.bounced / y.sent > 0.05) return `Yesterday ${((y.bounced / y.sent) * 100).toFixed(1)}% of emails bounced`;
  return null;
}

// What the campaign queue may send today. Transactional mail (API, confirmations, tests) keeps the normal daily limit.
export function warmupLimit(ws, yesterday, now = new Date()) {
  const base = ws.daily_limit || 0;
  const day = warmupDay(ws, now);
  if (!day) return { limit: base, active: false, day: null, done: false, hold: null, planned: base };
  const planned = capForDay(ws, day);
  const hold = healthHold(yesterday);
  let limit = Math.min(base, planned);
  if (hold) limit = Math.min(limit, Math.max(Number(ws.warmup_start_volume) || 50, yesterday.sent));
  return { limit, active: planned < base, day, done: planned >= base, hold, planned };
}

export function schedule(ws, days = 14, from = new Date()) {
  const start = warmupDay(ws, from) || 1;
  return Array.from({ length: days }, (_, i) => ({ day: start + i, cap: Math.min(ws.daily_limit || 0, capForDay(ws, start + i)) }));
}

// How many days a send of `total` emails takes when `leftToday` can go out today and the cap grows after that.
export function daysToSend(total, ws, leftToday, from = new Date()) {
  if (total <= leftToday) return 1;
  const day = warmupDay(ws, from);
  if (!day) return 1;
  let sent = leftToday, d = 1;
  while (sent < total && d < 60) { d += 1; const cap = Math.min(ws.daily_limit || 0, capForDay(ws, day + d - 1)); if (cap <= 0) break; sent += cap; }
  return d;
}
