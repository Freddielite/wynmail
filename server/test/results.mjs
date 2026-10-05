// Campaign results: A/B subject tests, resend to non-openers, best time, local time, time zones and unsubscribe reasons.
// Fresh empty database. Start the server with:
//   FORCE_PROVIDER=console JWT_SECRET=testsecret-testsecret-testsecret-12 AB_HOUR_MS=1000 BESTTIME_JITTER_MIN=0 QUEUE_TICK_MS=1500 node src/index.js
// and pass LOG=<server log file> and JWT_SECRET to this script. Takes about a minute.
import fs from 'fs';
import { wallToInstant } from '../src/timeutil.js';

const BASE = process.env.BASE || 'http://localhost:4000';
const LOG = process.env.LOG;
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 25000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* keep trying */ } await sleep(200); } return false; }
async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const form = (path, fields) => { const b = new URLSearchParams(); for (const [k, v] of Object.entries(fields)) b.append(k, String(v)); return fetch(BASE + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() }); };
const logText = () => fs.readFileSync(LOG, 'utf8');
const mailed = (email, subject) => logText().includes(`-> ${email} :: ${subject}`);
const W = '/api/workspaces/1';

const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', W, { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: '1 Main St, Abuja', rate_per_minute: 1000, daily_limit: 5000 } });
const mkList = async (name) => (await call('POST', `${W}/lists`, { token: A, body: { name } })).data;
const importCsv = (list, rows) => call('POST', `${W}/contacts/import`, { token: A, body: { list_id: list.id, csv: `email,first_name,time zone\n${rows.join('\n')}` } });
const html = '<p>Hello {{first_name|there}}, this is an email with enough words in it to be a real message.</p>';
const mkCamp = (over) => call('POST', `${W}/campaigns`, { token: A, body: { name: 'C', subject: 'Alpha subject', html, ...over } });
const msgs = async (id) => (await call('GET', `${W}/campaigns/${id}/messages`, { token: A })).data;
const camp = async (id) => (await call('GET', `${W}/campaigns`, { token: A })).data.find((c) => c.id === id);
const open = (token) => fetch(`${BASE}/t/o/${token}.png`);

/* ---------- validation ---------- */
const V = await mkList('Validation');
await importCsv(V, ['v1@example.com,V,']);
const bad = async (over) => (await mkCamp({ list_id: V.id, ...over })).status;
check('subject B must differ from subject A', (await bad({ subject_b: 'alpha SUBJECT' })) === 400);
check('the test group is 10 to 50 percent', (await bad({ subject_b: 'B', ab_percent: 5 })) === 400 && (await bad({ subject_b: 'B', ab_percent: 60 })) === 400);
check('the waiting time must be a listed choice', (await bad({ subject_b: 'B', ab_wait_hours: 3 })) === 400);
check('best time and local time cannot both be on', (await bad({ best_time: true, local_time: true, local_at: '2099-01-01T09:00' })) === 400);
check('an A/B test cannot be combined with timed delivery', (await bad({ subject_b: 'B', best_time: true })) === 400 && (await bad({ subject_b: 'B', local_time: true, local_at: '2099-01-01T09:00' })) === 400);
check('local time needs a real wall clock time in the future', (await bad({ local_time: true })) === 400 && (await bad({ local_time: true, local_at: 'soon' })) === 400 && (await bad({ local_time: true, local_at: '2020-01-01T09:00' })) === 400);
const okAb = await mkCamp({ list_id: V.id, subject_b: 'Bravo', ab_percent: 30, ab_wait_hours: 8, ab_metric: 'clicks' });
check('a valid A/B campaign is saved with its settings', okAb.status === 200 && okAb.data.subject_b === 'Bravo' && okAb.data.ab_percent === 30 && okAb.data.ab_wait_hours === 8 && okAb.data.ab_metric === 'clicks', JSON.stringify(okAb.data));
const dup = (await call('POST', `${W}/campaigns/${okAb.data.id}/duplicate`, { token: A })).data;
check('duplicating keeps the A/B settings', dup.subject_b === 'Bravo' && dup.ab_percent === 30);
const edit = await call('PUT', `${W}/campaigns/${okAb.data.id}`, { token: A, body: { subject: 'Alpha', list_id: V.id } });
check('editing without a test turns the test off', edit.status === 200 && edit.data.subject_b === null && edit.data.ab_percent === null);

/* ---------- A/B test ---------- */
const ABL = await mkList('AB list');
await importCsv(ABL, Array.from({ length: 24 }, (_, i) => `ab${i + 1}@example.com,Ab${i + 1},`));
const small = await mkList('Small');
await importCsv(small, Array.from({ length: 6 }, (_, i) => `sm${i + 1}@example.com,Sm${i + 1},`));
const smallCamp = (await mkCamp({ list_id: small.id, subject_b: 'Bravo small' })).data;
const smallSend = await call('POST', `${W}/campaigns/${smallCamp.id}/send`, { token: A });
check('a test on a tiny audience is refused with the reason', smallSend.status === 400 && /at least 20/.test(smallSend.data.error), JSON.stringify(smallSend.data));
check('and the campaign goes back to a draft with nothing queued', (await camp(smallCamp.id)).status === 'draft' && (await msgs(smallCamp.id)).length === 0);

const ab = (await mkCamp({ list_id: ABL.id, subject: 'Alpha subject', subject_b: 'Bravo subject', ab_percent: 50, ab_wait_hours: 1, ab_metric: 'opens' })).data;
const pre = await call('POST', `${W}/precheck`, { token: A, body: { subject: 'Alpha subject', subject_b: 'FREE MONEY!!!', html, list_id: ABL.id, ab_percent: 50 } });
check('the pre-send check also looks at subject B and explains the split', pre.data.items.some((i) => i.id === 'b_subject_punct') && pre.data.items.some((i) => i.id === 'ab_plan' && /6 people get each subject, then 12 get the winner/.test(i.title)), JSON.stringify(pre.data.items.map((i) => i.id + ':' + i.title)));
const preSmall = await call('POST', `${W}/precheck`, { token: A, body: { subject: 'Alpha', subject_b: 'Bravo', html, list_id: small.id } });
check('and warns when the audience is too small for a test', preSmall.data.items.some((i) => i.id === 'ab_audience' && i.level === 'fail'));
check('the report says the test has not started', (await call('GET', `${W}/campaigns/${ab.id}/ab`, { token: A })).data.state === 'not_started');
await call('POST', `${W}/campaigns/${ab.id}/send`, { token: A });
const phase = await until(async () => { const m = await msgs(ab.id); return m.filter((x) => x.ab_test && x.status === 'sent').length === 12 && m.filter((x) => x.status === 'held').length === 12 ? m : null; });
check('only the test group goes out first, everyone else waits', !!phase, JSON.stringify((await msgs(ab.id)).map((m) => m.status)));
if (phase) {
  const test = phase.filter((m) => m.ab_test);
  check('the test group is split evenly between the two subjects', test.filter((m) => m.variant === 'A').length === 6 && test.filter((m) => m.variant === 'B').length === 6);
  check('the report says the test is running', (await call('GET', `${W}/campaigns/${ab.id}/ab`, { token: A })).data.state === 'testing');
  await Promise.all(test.filter((m) => m.variant === 'B').map((m) => open(m.token)));
  const heldRows = phase.filter((m) => m.status === 'held');
  check('held people have no variant yet', heldRows.every((m) => m.variant === null && m.ab_test === false));
  const rep = await until(async () => { const r = (await call('GET', `${W}/campaigns/${ab.id}/ab`, { token: A })).data; return r.state === 'decided' ? r : null; });
  check('the version people opened wins', !!rep && rep.winner === 'B' && rep.tie === false && rep.B.opens === 6 && rep.A.opens === 0 && rep.metric === 'opens', JSON.stringify(rep));
  check('the report carries both versions numbers', !!rep && rep.A.sent === 6 && rep.B.sent === 6 && rep.B.open_rate === 100 && rep.test_size === 12);
  const done = await until(async () => { const m = await msgs(ab.id); return m.every((x) => x.status === 'sent') ? m : null; });
  check('then everyone else gets the winner and the campaign finishes', !!done && (await camp(ab.id)).status === 'sent', String((await msgs(ab.id)).map((m) => m.status)));
  if (done) {
    const rest = done.filter((m) => !m.ab_test);
    check('the rest all carry the winning variant', rest.length === 12 && rest.every((m) => m.variant === 'B'));
    const aMail = done.find((m) => m.ab_test && m.variant === 'A'), bMail = done.find((m) => m.ab_test && m.variant === 'B');
    check('each test version was sent with its own subject', mailed(aMail.email, 'Alpha subject') && mailed(bMail.email, 'Bravo subject'));
    check('the rest were sent with the winning subject', rest.every((m) => mailed(m.email, 'Bravo subject') && !mailed(m.email, 'Alpha subject')));
  }
}

/* ---------- resend to non-openers ---------- */
const RL = await mkList('Resend list');
await importCsv(RL, Array.from({ length: 10 }, (_, i) => `rs${i + 1}@example.com,Rs${i + 1},`));
const first = (await mkCamp({ list_id: RL.id, subject: 'First go', name: 'First go' })).data;
check('a draft cannot be resent', (await call('POST', `${W}/campaigns/${first.id}/resend`, { token: A, body: { subject: 'Again' } })).status === 400);
await call('POST', `${W}/campaigns/${first.id}/send`, { token: A });
const firstMsgs = await until(async () => { const m = await msgs(first.id); return m.length === 10 && m.every((x) => x.status === 'sent') ? m : null; });
check('the first send finishes', !!firstMsgs && (await until(async () => (await camp(first.id)).status === 'sent')));
const byEmail = (rows, e) => rows.find((m) => m.email === e);
for (const e of ['rs1@example.com', 'rs2@example.com', 'rs3@example.com']) await open(byEmail(firstMsgs, e).token);
await form(`/t/u/${byEmail(firstMsgs, 'rs4@example.com').token}`, {});   // rs4 unsubscribes
const c1 = await camp(first.id);
check('the campaign knows how many people did nothing', c1.non_openers === 6 && c1.resent === false, JSON.stringify({ n: c1.non_openers, r: c1.resent }));
check('a resend needs a new subject', (await call('POST', `${W}/campaigns/${first.id}/resend`, { token: A, body: { subject: 'first GO' } })).status === 400 && (await call('POST', `${W}/campaigns/${first.id}/resend`, { token: A, body: { subject: '' } })).status === 400);
const rs = await call('POST', `${W}/campaigns/${first.id}/resend`, { token: A, body: { subject: 'Did you miss this?' } });
check('the resend goes to everyone who did nothing and is still subscribed', rs.status === 200 && rs.data.queued === 6, JSON.stringify(rs.data));
const rsMsgs = await until(async () => { const m = await msgs(rs.data.id); return m.length === 6 && m.every((x) => x.status === 'sent') ? m : null; });
check('openers and the person who left are left out', !!rsMsgs && ['rs1', 'rs2', 'rs3', 'rs4'].every((n) => !rsMsgs.some((m) => m.email === `${n}@example.com`)) && ['rs5', 'rs6', 'rs7', 'rs8', 'rs9', 'rs10'].every((n) => rsMsgs.some((m) => m.email === `${n}@example.com`)));
check('they got the new subject', !!rsMsgs && rsMsgs.every((m) => mailed(m.email, 'Did you miss this?')));
check('it can only be resent once', (await call('POST', `${W}/campaigns/${first.id}/resend`, { token: A, body: { subject: 'Third time' } })).status === 400);
const after = await camp(first.id), rsRow = await camp(rs.data.id);
check('the lists show it was resent, and where from', after.resent === true && rsRow.resend_of_name === 'First go');
const empty = (await mkCamp({ list_id: V.id, subject: 'Only one' })).data;
await call('POST', `${W}/campaigns/${empty.id}/send`, { token: A });
const emptyMsgs = await until(async () => { const m = await msgs(empty.id); return m.length === 1 && m[0].status === 'sent' ? m : null; });
await open(emptyMsgs[0].token);
const noOne = await call('POST', `${W}/campaigns/${empty.id}/resend`, { token: A, body: { subject: 'Nope' } });
check('a resend with nobody to send to says so and leaves nothing behind', noOne.status === 400 && /opened it/.test(noOne.data.error) && !(await call('GET', `${W}/campaigns`, { token: A })).data.some((c) => c.resend_of === empty.id));

/* ---------- time zones on contacts ---------- */
const TZ = await mkList('Zones');
const csv = await importCsv(TZ, ['tz1@example.com,Lagos,Africa/Lagos', 'tz2@example.com,York,America/New_York', 'tz3@example.com,Nozone,', 'tz4@example.com,Kiri,Pacific/Kiritimati', 'tz5@example.com,Bad,Mars/Base']);
const contacts = async () => (await call('GET', `${W}/contacts`, { token: A })).data;
const cOf = async (e) => (await contacts()).find((c) => c.email === e);
check('an import reads the time zone column and ignores nonsense', csv.status === 200 && (await cOf('tz1@example.com')).timezone === 'Africa/Lagos' && (await cOf('tz5@example.com')).timezone === null && (await cOf('tz3@example.com')).timezone === null);
check('it does not leave a stray time zone attribute', !('time_zone' in (await cOf('tz1@example.com')).attributes));
const tz3 = (await cOf('tz3@example.com')).id;
check('a profile can be given a zone', (await call('PUT', `${W}/profile/${tz3}`, { token: A, body: { timezone: 'Africa/Lagos' } })).status === 200 && (await cOf('tz3@example.com')).timezone === 'Africa/Lagos');
check('an invalid zone on a profile is refused', (await call('PUT', `${W}/profile/${tz3}`, { token: A, body: { timezone: 'Mars/Base' } })).status === 400);
check('and a zone can be cleared', (await call('PUT', `${W}/profile/${tz3}`, { token: A, body: { timezone: '' } })).status === 200 && (await cOf('tz3@example.com')).timezone === null);
const key = (await call('POST', `${W}/api-keys`, { token: A, body: { name: 'k' } })).data.key;
const api = await fetch(`${BASE}/v1/contacts`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ email: 'api-tz@example.com', timezone: 'Asia/Kolkata' }) });
check('the API accepts a zone', api.status === 200 && (await api.json()).timezone === 'Asia/Kolkata');
check('the owner can set the workspace zone, and only a real one', (await call('PUT', W, { token: A, body: { default_timezone: 'Mars/Base' } })).status === 400 && (await call('PUT', W, { token: A, body: { default_timezone: 'Africa/Lagos' } })).data.default_timezone === 'Africa/Lagos');

const fm = (await call('POST', `${W}/forms`, { token: A, body: { name: 'Zone form', title: 'Join', consent_text: 'I agree to receive emails.', list_id: TZ.id, double_optin: false } })).data;
const t = (await (await fetch(`${BASE}/f/${fm.slug}`)).text());
check('the hosted form asks the browser for its time zone', /name="tz"/.test(t) && /resolvedOptions\(\)\.timeZone/.test(t));
const tok = t.match(/name="t" value="([^"]+)"/)[1];
await sleep(2200);
const sub = (email, tz) => fetch(`${BASE}/f/${fm.slug}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email, consent: 'on', t: tok, tz }) });
await sub('formtz@example.com', 'Europe/London'); await sub('formbad@example.com', 'Not/AZone');
await sleep(700);
check('a signup saves the visitors zone, and drops an invalid one', (await cOf('formtz@example.com'))?.timezone === 'Europe/London' && (await cOf('formbad@example.com'))?.timezone === null);

/* ---------- local time delivery ---------- */
const d = new Date(Date.now() + 2 * 86400000);
const localAt = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T09:00`;
const lc = await mkCamp({ list_id: TZ.id, subject: 'Good morning', local_time: true, local_at: localAt });
check('a local time campaign is scheduled for when the first zone reaches that time', lc.status === 200 && lc.data.status === 'scheduled' && lc.data.local_time === true && lc.data.local_at === localAt && new Date(lc.data.scheduled_at).toISOString() === wallToInstant(localAt, 'Pacific/Kiritimati').toISOString(), JSON.stringify(lc.data));
await call('POST', `${W}/campaigns/${lc.data.id}/send`, { token: A });
const lm = await until(async () => { const m = await msgs(lc.data.id); return m.length >= 4 ? m : null; });
const when = (e) => lm.find((m) => m.email === e)?.send_after;
const want = (zone) => wallToInstant(localAt, zone).toISOString();
check('each person is timed to their own zone', !!lm && new Date(when('tz1@example.com')).toISOString() === want('Africa/Lagos') && new Date(when('tz2@example.com')).toISOString() === want('America/New_York') && new Date(when('tz4@example.com')).toISOString() === want('Pacific/Kiritimati'), JSON.stringify(lm?.map((m) => [m.email, m.send_after])));
check('people with no zone get the workspace zone', !!lm && new Date(when('tz3@example.com')).toISOString() === want('Africa/Lagos'));
check('nothing leaves before its time and the campaign stays open', !!lm && lm.every((m) => m.status === 'queued') && (await camp(lc.data.id)).status === 'sending' && (await camp(lc.data.id)).timed_waiting >= 4);
await call('DELETE', `${W}/campaigns/${lc.data.id}`, { token: A });

/* ---------- best time ---------- */
const BT = await mkList('Best time');
await importCsv(BT, Array.from({ length: 6 }, (_, i) => `bt${i + 1}@example.com,Bt${i + 1},`));
const btHist = (await mkCamp({ list_id: BT.id, subject: 'History' })).data;
await call('POST', `${W}/campaigns/${btHist.id}/send`, { token: A });
const hm = await until(async () => { const m = await msgs(btHist.id); return m.length === 6 && m.every((x) => x.status === 'sent') ? m : null; });
for (let i = 0; i < 3; i += 1) await open(byEmail(hm, 'bt1@example.com').token);
for (const e of ['bt2@example.com', 'bt3@example.com']) for (let i = 0; i < 12; i += 1) await open(byEmail(hm, e).token);
await sleep(300);
const bc = (await mkCamp({ list_id: BT.id, subject: 'At your best time', best_time: true })).data;
check('best time is saved on the campaign', bc.best_time === true);
await call('POST', `${W}/campaigns/${bc.id}/send`, { token: A });
const bm = await until(async () => { const m = await msgs(bc.id); return m.length === 6 && m.every((x) => x.status === 'sent') ? m : null; });
const hourNow = new Date().getUTCHours();
check('everyone is timed to the hour they open in, and it goes out', !!bm && bm.every((m) => m.send_after && [hourNow, (hourNow + 23) % 24].includes(new Date(m.send_after).getUTCHours())), JSON.stringify(bm?.map((m) => m.send_after)));
const nobody = await mkList('No history');
await importCsv(nobody, ['nh@example.com,Nh,']);
const hz = (await mkCamp({ list_id: nobody.id, subject: 'Fallback hour', best_time: true })).data;
await call('POST', `${W}/campaigns/${hz.id}/send`, { token: A });
check('a person with no opens gets the hour most of the list opens in', !!(await until(async () => { const m = await msgs(hz.id); return m.length === 1 && m[0].send_after && m[0].status === 'sent'; })));
const pre2 = await call('POST', `${W}/precheck`, { token: A, body: { subject: 'Hello there', html, list_id: BT.id, best_time: true } });
check('the pre-send check explains the timing', pre2.data.items.some((i) => i.id === 'timing_best'));

/* ---------- why people unsubscribe ---------- */
const UL = await mkList('Leavers');
await importCsv(UL, Array.from({ length: 5 }, (_, i) => `lv${i + 1}@example.com,Lv${i + 1},`));
const uc = (await mkCamp({ list_id: UL.id, subject: 'Leaving test' })).data;
await call('POST', `${W}/campaigns/${uc.id}/send`, { token: A });
const um = await until(async () => { const m = await msgs(uc.id); return m.length === 5 && m.every((x) => x.status === 'sent') ? m : null; });
const tk = (n) => byEmail(um, `lv${n}@example.com`).token;
const survey0 = await form(`/t/r/${tk(1)}`, { reason: 'too_many' });
check('the survey is refused until the person has really unsubscribed', survey0.status === 400);
const gone = await (await form(`/t/u/${tk(1)}`, {})).text();
check('after unsubscribing the person is asked why, with no scripts', gone.includes('Why are you leaving') && gone.includes('I never signed up for these') && !/<script/i.test(gone));
const s1 = await form(`/t/r/${tk(1)}`, { reason: 'too_many', comment: 'Twice a day is a lot <b>please</b>' });
check('an answer is thanked', s1.status === 200 && (await s1.text()).includes('Thank you'));
await form(`/t/r/${tk(1)}`, { reason: 'not_relevant' });
await form(`/t/u/${tk(2)}`, {}); await form(`/t/r/${tk(2)}`, { reason: 'never_signed_up' });
await form(`/t/u/${tk(3)}`, {}); await form(`/t/r/${tk(3)}`, { reason: 'made-up' });
await form(`/t/u/${tk(4)}`, {});
const an = (await call('GET', `${W}/analytics/unsubscribe-reasons?days=30`, { token: A })).data;
check('each person is counted once, and the first answer stands', an.answered === 2 && an.reasons.length === 2 && an.reasons.some((r) => r.reason === 'too_many' && r.count === 1) && !an.reasons.some((r) => r.reason === 'not_relevant'), JSON.stringify(an));
check('an unknown reason is ignored', !an.reasons.some((r) => r.reason === 'made-up'));
check('the totals show how many left and how many answered', an.unsubscribed >= 5 && an.never_signed_up === 1, JSON.stringify(an));
check('comments are kept as plain text for the owner to read', an.comments.length === 1 && an.comments[0].comment.includes('<b>please</b>') && an.comments[0].label === 'I get too many emails');
check('the answers belong to one workspace only', !(await call('GET', '/api/workspaces/1/analytics/unsubscribe-reasons', {})).data.reasons);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
