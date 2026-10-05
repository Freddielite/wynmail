// Time zone helpers. Everything here is pure, so it can be tested without a database.

export const validTz = (tz) => {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};
export const cleanTz = (tz) => (validTz(String(tz ?? '').trim()) ? String(tz).trim() : null);

const fmt = new Map();
function parts(date, tz) {
  let f = fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmt.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = Number(p.value);
  return o;
}

// How far ahead of UTC the zone is at this instant, in milliseconds.
export function offsetMs(date, tz) {
  const p = parts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

export const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

// A wall clock time like "2026-10-12T09:00" in a zone, as the real instant. Handles daylight saving shifts.
export function wallToInstant(local, tz) {
  const m = LOCAL_RE.exec(String(local));
  if (!m || !validTz(tz)) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(guess)) return null;
  let t = guess - offsetMs(new Date(guess), tz);
  const second = guess - offsetMs(new Date(t), tz);
  if (second !== t) t = second;
  return new Date(t);
}

// The earliest place on Earth to reach a given wall clock time is UTC+14. Enqueueing then means nobody is late.
export const EARLIEST_ZONE = 'Pacific/Kiritimati';
export const earliestInstant = (local) => wallToInstant(local, EARLIEST_ZONE);

// Best hour of the day (UTC) for each person, from the hours they opened in.
// Needs at least three opens. Everyone else falls back to the hour most of the workspace opens in.
export const MIN_OPENS = 3;
export function modeHour(hours) {
  const n = new Array(24).fill(0);
  for (const h of hours) if (Number.isInteger(h) && h >= 0 && h < 24) n[h] += 1;
  const max = Math.max(...n);
  if (!max) return null;
  return n.indexOf(max);
}

// The next moment the given UTC hour begins, counting the current hour as available. jitterMin spreads people
// out inside the hour so thousands of emails do not all leave in the same minute.
export function nextAtHour(hour, now = new Date(), jitterMin = 0, rand = Math.random) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
  const ahead = (hour - now.getUTCHours() + 24) % 24;
  return new Date(start + ahead * 3600000 + Math.floor(rand() * (jitterMin + 1)) * 60000);
}

export const DAY_MS = 86400000;
// Dates in contact fields must be written YYYY-MM-DD. Anything else, or an impossible date, is ignored.
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? { y, mo, d } : null;
}
export const dayNumber = (y, mo, d) => Math.floor(Date.UTC(y, mo - 1, d) / DAY_MS);
export const todayIn = (tz, now = new Date()) => { const p = parts(now, validTz(tz) ? tz : 'UTC'); return { y: p.year, mo: p.month, d: p.day }; };

// Does this contact's date fall on the given day, once the offset is applied? Birthdays repeat every year.
// Returns the year to use as the run cycle, or null.
export function dateDue(value, { offsetDays = 0, yearly = false, day }) {
  const p = parseDate(value);
  if (!p) return null;
  const target = dayNumber(day.y, day.mo, day.d) - offsetDays;        // the day the date itself has to be on
  const t = new Date(target * DAY_MS);
  const [ty, tm, td] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  if (!yearly) return dayNumber(p.y, p.mo, p.d) === target ? p.y : null;
  if (p.mo === tm && p.d === td) return day.y;
  // 29 February in a year with no 29 February is celebrated on 28 February.
  const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (p.mo === 2 && p.d === 29 && !leap(ty) && tm === 2 && td === 28) return day.y;
  return null;
}
