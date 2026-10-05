// Pure tests for time zones, best hours, date triggers, A/B winners and the CSV time zone column. Needs nothing running.
import { validTz, cleanTz, wallToInstant, earliestInstant, nextAtHour, modeHour, parseDate, dateDue, todayIn, dayNumber, offsetMs } from '../src/timeutil.js';
import { pickWinner, abPlan } from '../src/abtest.js';
import { readContacts } from '../src/csv.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const iso = (d) => d?.toISOString();

/* ---------- time zones ---------- */
check('real zone names are accepted, nonsense is not', validTz('Africa/Lagos') && validTz('America/New_York') && validTz('UTC') && !validTz('Mars/Base') && !validTz('') && !validTz('a'.repeat(80)) && !validTz("Africa/Lagos'; DROP"));
check('cleanTz trims and drops bad values', cleanTz(' Africa/Lagos ') === 'Africa/Lagos' && cleanTz('nope') === null && cleanTz(null) === null && cleanTz(42) === null);
check('Lagos is one hour ahead of UTC', iso(wallToInstant('2026-10-12T09:00', 'Africa/Lagos')) === '2026-10-12T08:00:00.000Z');
check('New York in summer time is four hours behind', iso(wallToInstant('2026-10-12T09:00', 'America/New_York')) === '2026-10-12T13:00:00.000Z');
check('New York in winter time is five hours behind', iso(wallToInstant('2026-12-12T09:00', 'America/New_York')) === '2026-12-12T14:00:00.000Z');
check('India is five and a half hours ahead', iso(wallToInstant('2026-10-12T09:00', 'Asia/Kolkata')) === '2026-10-12T03:30:00.000Z');
check('the clocks going forward skips a time without breaking', wallToInstant('2026-03-08T02:30', 'America/New_York') instanceof Date);
check('the clocks going back repeats a time, the first one wins', iso(wallToInstant('2026-11-01T01:30', 'America/New_York')) === '2026-11-01T05:30:00.000Z');
check('bad times and zones give nothing', wallToInstant('tomorrow', 'Africa/Lagos') === null && wallToInstant('2026-10-12T09:00', 'Nowhere/Land') === null && wallToInstant('2026-10-12 09:00', 'UTC') === null);
check('the first zone to reach a time is UTC+14', iso(earliestInstant('2026-10-12T09:00')) === '2026-10-11T19:00:00.000Z');
check('the offset of a zone is read correctly', offsetMs(new Date('2026-10-12T12:00:00Z'), 'Africa/Lagos') === 3600000 && offsetMs(new Date('2026-10-12T12:00:00Z'), 'UTC') === 0);

/* ---------- best hour ---------- */
check('the most common hour wins, nothing gives null', modeHour([9, 9, 14, 9, 14]) === 9 && modeHour([]) === null && modeHour([30, -1, 'x']) === null);
const at = new Date('2026-10-04T10:30:00Z');
check('a later hour today', iso(nextAtHour(15, at)) === '2026-10-04T15:00:00.000Z');
check('an earlier hour means tomorrow', iso(nextAtHour(8, at)) === '2026-10-05T08:00:00.000Z');
check('the current hour starts at the top of the hour, so it goes now', iso(nextAtHour(10, at)) === '2026-10-04T10:00:00.000Z');
check('jitter spreads people inside the hour and never past it', iso(nextAtHour(15, at, 50, () => 0.999)) === '2026-10-04T15:50:00.000Z' && iso(nextAtHour(15, at, 50, () => 0)) === '2026-10-04T15:00:00.000Z');
check('the next hour never lands more than a day away', [0, 5, 10, 23].every((h) => { const d = nextAtHour(h, at) - at; return d > -3600000 && d < 86400000; }));

/* ---------- date fields ---------- */
check('only year-month-day dates are read, impossible dates are not', parseDate('2026-10-12')?.mo === 10 && parseDate('12/10/2026') === null && parseDate('2026-02-30') === null && parseDate('') === null && parseDate(null) === null && parseDate('2026-13-01') === null);
const day = (s) => { const [y, mo, d] = s.split('-').map(Number); return { y, mo, d }; };
check('a plain date fires on the day', dateDue('2026-10-12', { day: day('2026-10-12') }) === 2026 && dateDue('2026-10-12', { day: day('2026-10-13') }) === null);
check('a plain date does not repeat every year', dateDue('2025-10-12', { day: day('2026-10-12') }) === null);
check('a birthday fires every year, in the year it is celebrated', dateDue('1990-10-12', { yearly: true, day: day('2026-10-12') }) === 2026 && dateDue('1990-10-12', { yearly: true, day: day('2027-10-12') }) === 2027 && dateDue('1990-10-12', { yearly: true, day: day('2026-10-13') }) === null);
check('days before the date fire early', dateDue('2026-10-12', { offsetDays: -7, day: day('2026-10-05') }) === 2026 && dateDue('2026-10-12', { offsetDays: -7, day: day('2026-10-12') }) === null);
check('days after the date fire late', dateDue('2026-10-12', { offsetDays: 3, day: day('2026-10-15') }) === 2026);
check('a yearly date with an offset crosses the year end', dateDue('1990-01-02', { yearly: true, offsetDays: -3, day: day('2026-12-30') }) === 2026 && dateDue('1990-01-02', { yearly: true, offsetDays: -3, day: day('2026-12-31') }) === null);
check('29 February is celebrated on 28 February in other years', dateDue('2000-02-29', { yearly: true, day: day('2027-02-28') }) === 2027 && dateDue('2000-02-29', { yearly: true, day: day('2028-02-29') }) === 2028 && dateDue('2000-02-29', { yearly: true, day: day('2028-02-28') }) === null);
check('today is read in the workspace time zone', (() => { const t = todayIn('Pacific/Kiritimati', new Date('2026-10-04T12:00:00Z')); return t.d === 5 && t.mo === 10; })() && todayIn('Pacific/Pago_Pago', new Date('2026-10-04T05:00:00Z')).d === 3);
check('day numbers count whole days', dayNumber(2026, 10, 5) - dayNumber(2026, 10, 4) === 1);

/* ---------- A/B ---------- */
const v = (sent, opens, clicks = 0) => ({ sent, opens, clicks });
check('the better open rate wins', pickWinner(v(50, 10), v(50, 20), 'opens').winner === 'B' && pickWinner(v(50, 25), v(50, 20), 'opens').winner === 'A');
check('rates are compared, not counts', pickWinner(v(100, 20), v(50, 12), 'opens').winner === 'B');
check('clicks can be the measure', pickWinner(v(50, 40, 2), v(50, 10, 9), 'clicks').winner === 'B');
check('a tie goes to the original subject and says so', (() => { const r = pickWinner(v(50, 0), v(50, 0), 'opens'); return r.winner === 'A' && r.tie === true; })());
check('a test with nobody sent does not crash', pickWinner(v(0, 0), v(0, 0), 'opens').winner === 'A');
check('the plan has at least five per version', abPlan(20, 10).per === 5 && abPlan(20, 10).test === 10 && abPlan(20, 10).rest === 10);
check('the plan scales with the audience', abPlan(1000, 20).per === 100 && abPlan(1000, 20).rest === 800 && abPlan(1000, 50).rest === 500);

/* ---------- CSV time zone column ---------- */
const rows = [['Email', 'First Name', 'Time Zone', 'Plan'], ['a@example.com', 'A', 'Africa/Lagos', 'pro'], ['b@example.com', 'B', '', 'free']];
const r = readContacts(rows, { isEmail: (e) => /@/.test(e), normEmail: (e) => String(e || '').trim().toLowerCase() });
check('a time zone column fills the time zone, not an attribute', r.contacts[0].timezone === 'Africa/Lagos' && r.contacts[0].attributes.plan === 'pro' && !('time_zone' in r.contacts[0].attributes) && r.contacts[1].timezone === '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
