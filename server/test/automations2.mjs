// Automations: new triggers (tag, link click, date), branches and conditions, exit goals.
// Fresh empty database. Start the server with:
//   FORCE_PROVIDER=console JWT_SECRET=testsecret-testsecret-testsecret-12 AUTOMATION_MINUTE_MS=1000 QUEUE_TICK_MS=1500 node src/index.js
// and pass LOG=<server log file> and JWT_SECRET to this script. Takes about a minute.
import fs from 'fs';
import crypto from 'crypto';
import { todayIn, dayNumber } from '../src/timeutil.js';

const BASE = process.env.BASE || 'http://localhost:4000';
const LOG = process.env.LOG, SECRET = process.env.JWT_SECRET;
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 25000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* keep trying */ } await sleep(250); } return false; }
async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const log = () => fs.readFileSync(LOG, 'utf8');
const mailed = (email, subject) => log().includes(`-> ${email} :: ${subject}`);
const tokenFor = (email, subject) => (log().match(new RegExp(`-> ${email.replace(/[.+]/g, '\\$&')} :: ${subject.replace(/[?.]/g, '\\$&')} \\| t=([a-f0-9]{32})`)) || [])[1];
const sig = (token, url) => crypto.createHmac('sha256', SECRET).update(`c:${token}:${url}`).digest('hex').slice(0, 32);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const clickUrl = (token, url) => fetch(`${BASE}/t/c/${token}?url=${encodeURIComponent(url)}&sig=${sig(token, url)}`, { redirect: 'manual', headers: { 'User-Agent': UA } });
const openMail = (token) => fetch(`${BASE}/t/o/${token}.png`, { headers: { 'User-Agent': UA } });

const W = '/api/workspaces/1';
const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', W, { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: '1 Main St, Abuja', rate_per_minute: 1000, daily_limit: 5000 } });
const made = await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'owner@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } });
const O = (await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'acme-pass-99' } })).data.token;
const otherList = (await call('POST', `/api/workspaces/${made.data.id}/lists`, { token: O, body: { name: 'Acme list' } })).data;
const mkList = async (name) => (await call('POST', `${W}/lists`, { token: A, body: { name } })).data;
const step = (subject, over = {}) => ({ kind: 'email', subject, delay_minutes: 0, html: '<p>Hi {{first_name|there}}, this is a step of an automation with enough text.</p>', ...over });
const make = (over, token = A, ws = 1) => call('POST', `/api/workspaces/${ws}/automations`, { token, body: { name: 'Auto', trigger_type: 'tag_added', trigger_value: 'seed', active: true, steps: [step('S')], ...over } });
const add = (email, first, extra = {}) => call('POST', `${W}/contacts`, { token: A, body: { email, first_name: first, ...extra } });
const contacts = async () => (await call('GET', `${W}/contacts`, { token: A })).data;
const cOf = async (e) => (await contacts()).find((c) => c.email === e);
const stat = async (id) => (await call('GET', `${W}/automations`, { token: A })).data.find((a) => a.id === id);
const runs = async (id) => (await call('GET', `${W}/automations/${id}/runs`, { token: A })).data;
const runOf = async (id, email) => (await runs(id)).find((r) => r.email === email);
const setTags = (email, tags) => cOf(email).then((c) => call('PUT', `${W}/profile/${c.id}`, { token: A, body: { tags } }));

/* ---------- validation ---------- */
const L = await mkList('Main');
const v = async (over) => (await make({ active: false, ...over })).status;
check('a tag trigger needs a tag', (await v({ trigger_value: '' })) === 400);
check('a link trigger needs at least three characters', (await v({ trigger_type: 'link_click', trigger_value: 'ab' })) === 400);
check('a date trigger needs a field name and a sane offset', (await v({ trigger_type: 'date_field', trigger_value: 'bad name' })) === 400 && (await v({ trigger_type: 'date_field', trigger_value: 'birthday', trigger_offset_days: 400 })) === 400 && (await v({ trigger_type: 'date_field', trigger_value: 'birthday', trigger_offset_days: 1.5 })) === 400);
check('a list trigger still needs a list from this workspace', (await v({ trigger_type: 'list_join' })) === 400 && (await v({ trigger_type: 'list_join', list_id: otherList.id })) === 400 && (await v({ trigger_type: 'list_join', list_id: L.id })) === 200);
check('an unknown trigger falls back to the list trigger and so needs a list', (await v({ trigger_type: 'nonsense' })) === 400);
check('a goal needs its value, and a list goal needs a list of this workspace', (await v({ goal_type: 'tag', goal_value: '' })) === 400 && (await v({ goal_type: 'link', goal_value: 'x' })) === 400 && (await v({ goal_type: 'list', goal_value: otherList.id })) === 400 && (await v({ goal_type: 'tag', goal_value: 'bought' })) === 200);
check('an automation made only of conditions has no email', (await v({ steps: [{ kind: 'condition', cond: { type: 'has_tag', value: 'x' } }] })) === 400);
check('a condition must name what to check', (await v({ steps: [step('S'), { kind: 'condition', cond: { type: 'telepathy' } }] })) === 400 && (await v({ steps: [step('S'), { kind: 'condition', cond: { type: 'has_tag', value: '' } }] })) === 400 && (await v({ steps: [step('S'), { kind: 'condition', cond: { type: 'attr_equals', key: 'plan' } }] })) === 400 && (await v({ steps: [step('S'), { kind: 'condition', cond: { type: 'on_list', value: otherList.id } }] })) === 400);
check('opened can only point at an earlier email', (await v({ steps: [step('S'), { kind: 'condition', cond: { type: 'opened', value: 1 } }] })) === 400 && (await v({ steps: [{ kind: 'tag', tag_value: 't' }, step('S'), { kind: 'condition', cond: { type: 'opened', value: 0 } }] })) === 400 && (await v({ steps: [step('S'), { kind: 'condition', cond: { type: 'opened', value: 0 }, yes_to: -1 }] })) === 200);
check('a branch can only go forward, never back', (await v({ steps: [step('S'), { kind: 'condition', cond: { type: 'has_tag', value: 'x' }, yes_to: 0 }, step('T')] })) === 400 && (await v({ steps: [step('S'), { kind: 'condition', cond: { type: 'has_tag', value: 'x' }, yes_to: 1 }, step('T')] })) === 400 && (await v({ steps: [step('S'), { kind: 'condition', cond: { type: 'has_tag', value: 'x' }, yes_to: 9 }, step('T')] })) === 400 && (await v({ steps: [step('S'), { kind: 'condition', cond: { type: 'has_tag', value: 'x' }, yes_to: 2 }, step('T')] })) === 200);
check('an email can only skip forward too', (await v({ steps: [step('S', { then_to: 0 }), step('T')] })) === 400 && (await v({ steps: [step('S', { then_to: 1 }), step('T')] })) === 200 && (await v({ steps: [step('S', { then_to: -1 }), step('T')] })) === 200);
check('a tag step needs a tag', (await v({ steps: [step('S'), { kind: 'tag', tag_value: '' }] })) === 400);
check('at most twenty steps, ten of them emails', (await v({ steps: Array.from({ length: 21 }, (_, i) => step('S' + i)) })) === 400 && (await v({ steps: Array.from({ length: 11 }, (_, i) => step('S' + i)) })) === 400);

/* ---------- start everything running ---------- */
const sendersOk = (await make({ name: 'Tag VIP', trigger_value: 'vip', steps: [step('VIP welcome')] })).status === 200;
check('a tag automation can be turned on', sendersOk);
const tagAuto = (await call('GET', `${W}/automations`, { token: A })).data.find((a) => a.name === 'Tag VIP');
const impAuto = (await make({ name: 'Tag import', trigger_value: 'imported', include_imports: true, steps: [step('Import welcome')] })).data;
const clickAuto = (await make({ name: 'Click', trigger_type: 'link_click', trigger_value: 'wynmail-offer', steps: [step('Click follow up')] })).data;
const dateAuto = (await make({ name: 'Renewal', trigger_type: 'date_field', trigger_value: 'renewal', trigger_offset_days: -1, steps: [step('Renewal soon')] })).data;
const dayAuto = (await make({ name: 'On the day', trigger_type: 'date_field', trigger_value: 'expires', trigger_offset_days: 0, steps: [step('Expires today')] })).data;
const birthAuto = (await make({ name: 'Birthday', trigger_type: 'date_field', trigger_value: 'birthday', trigger_yearly: true, steps: [step('Happy birthday')] })).data;

const XL = await mkList('Branch list');
const branch = (await make({
  name: 'Branch', trigger_type: 'list_join', list_id: XL.id,
  steps: [
    step('X Offer'),
    { kind: 'condition', delay_minutes: 3, cond: { type: 'opened', value: 0 }, yes_to: 3, no_to: 2 },
    step('X Nudge', { then_to: 4 }),
    step('X Thanks'),
    { kind: 'tag', tag_action: 'add', tag_value: 'x-done' }
  ]
})).data;
const YL = await mkList('Cond list');
const cond = (type, value, key) => ({ kind: 'condition', cond: { type, value, ...(key ? { key } : {}) }, yes_to: -1 });
const condAuto = async (name, c, subjects) => (await make({ name, trigger_type: 'list_join', list_id: YL.id, steps: [step(subjects[0]), c, step(subjects[1])] })).data;
const GL = await mkList('Goal list');
const goalTag = (await make({ name: 'Goal tag', trigger_type: 'list_join', list_id: (await mkList('GT')).id, goal_type: 'tag', goal_value: 'bought', steps: [step('G1 first'), step('G1 second', { delay_minutes: 4 })] })).data;
const goalTagList = (await call('GET', `${W}/automations`, { token: A })).data.find((a) => a.id === goalTag.id).list_id;
const goalLinkL = await mkList('GLink');
const goalLink = (await make({ name: 'Goal link', trigger_type: 'list_join', list_id: goalLinkL.id, goal_type: 'link', goal_value: 'checkout', steps: [step('L1 first'), step('L1 second', { delay_minutes: 9 })] })).data;
const goalListL = await mkList('GListTrigger');
const goalList = (await make({ name: 'Goal list', trigger_type: 'list_join', list_id: goalListL.id, goal_type: 'list', goal_value: GL.id, steps: [step('GL first'), step('GL second', { delay_minutes: 4 })] })).data;

/* ---------- tag trigger ---------- */
await add('t1@example.com', 'T1');
await sleep(2500);
check('adding a contact without the tag starts nothing', !mailed('t1@example.com', 'VIP welcome'));
await setTags('t1@example.com', ['vip']);
check('adding the tag starts the automation', !!(await until(() => mailed('t1@example.com', 'VIP welcome'))));
await setTags('t1@example.com', ['vip', 'other']);
await setTags('t1@example.com', []);
await setTags('t1@example.com', ['vip']);
await sleep(2500);
check('taking the tag away and adding it back does not start it again', (await stat(tagAuto.id)).enrolled === 1 && (log().match(/t1@example.com :: VIP welcome/g) || []).length === 1);
await add('t2@example.com', 'T2', { tags: ['VIP'] });
check('a tag on a new contact, in any case, starts it', !!(await until(() => mailed('t2@example.com', 'VIP welcome'))));
const apiKey = (await call('POST', `${W}/api-keys`, { token: A, body: { name: 'k' } })).data.key;
await fetch(`${BASE}/v1/contacts`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ email: 't3@example.com', tags: ['vip'] }) });
check('a tag added through the API starts it too', !!(await until(() => mailed('t3@example.com', 'VIP welcome'))));
const il = await mkList('Import list');
await call('POST', `${W}/contacts/import`, { token: A, body: { list_id: il.id, csv: 'email,first_name,tags\nimp1@example.com,Imp,imported;vip' } });
await sleep(3000);
check('tags from an import start only the automations that allow imports', mailed('imp1@example.com', 'Import welcome') && !mailed('imp1@example.com', 'VIP welcome'));
const paused = (await call('POST', `${W}/automations/${tagAuto.id}/status`, { token: A, body: { active: false } }));
await add('t4@example.com', 'T4', { tags: ['vip'] });
await sleep(2500);
check('a paused automation starts nobody', !mailed('t4@example.com', 'VIP welcome'));
await call('POST', `${W}/automations/${tagAuto.id}/status`, { token: A, body: { active: true } });

/* ---------- link click trigger ---------- */
const cl = await mkList('Clickers');
await add('ck1@example.com', 'Ck', { list_id: cl.id });
const cc = (await call('POST', `${W}/campaigns`, { token: A, body: { name: 'Offer mail', subject: 'The offer', html: '<p>Hello there, this offer is for you and it has enough words in it.</p>', list_id: cl.id } })).data;
await call('POST', `${W}/campaigns/${cc.id}/send`, { token: A });
const ccTok = await until(() => tokenFor('ck1@example.com', 'The offer'));
await clickUrl(ccTok, 'https://shop.example/wynmail-offer?x=1');
await sleep(3000);
check('a click within five seconds is a scanner and starts nothing', !mailed('ck1@example.com', 'Click follow up'));
await sleep(3500);
await clickUrl(ccTok, 'https://shop.example/other-page');
await sleep(2500);
check('a click on a different link starts nothing', !mailed('ck1@example.com', 'Click follow up'));
await clickUrl(ccTok, 'https://shop.example/Wynmail-Offer?x=2');
check('a real click on the chosen link starts it, whatever the case', !!(await until(() => mailed('ck1@example.com', 'Click follow up'))));
await clickUrl(ccTok, 'https://shop.example/wynmail-offer?x=3');
await sleep(2500);
check('clicking again does not start it twice', (await stat(clickAuto.id)).enrolled === 1);

/* ---------- date trigger ---------- */
const day = (offset) => { const t = todayIn('Africa/Lagos'); const d = new Date((dayNumber(t.y, t.mo, t.d) + offset) * 86400000); return d.toISOString().slice(0, 10); };
const mmdd = day(0).slice(5);
const dl = await mkList('Dates');
for (const [e, attrs] of [
  ['d1@example.com', { renewal: day(1) }], ['d2@example.com', { renewal: day(2) }], ['d3@example.com', { renewal: 'soon' }],
  ['d4@example.com', { expires: day(0) }], ['d5@example.com', { expires: day(-1) }],
  ['d6@example.com', { birthday: `1990-${mmdd}` }], ['d7@example.com', { birthday: `1990-${day(1).slice(5)}` }], ['d8@example.com', { birthday: '12/05/1990' }]
]) await call('POST', `${W}/contacts`, { token: A, body: { email: e, first_name: e.slice(0, 2), list_id: dl.id, attributes: attrs } });
await call('POST', `${W}/automations/${dateAuto.id}/status`, { token: A, body: { active: true } });
await call('POST', `${W}/automations/${dayAuto.id}/status`, { token: A, body: { active: true } });
await call('POST', `${W}/automations/${birthAuto.id}/status`, { token: A, body: { active: true } });
check('a date one day ahead starts a "1 day before" automation', !!(await until(() => mailed('d1@example.com', 'Renewal soon'))));
check('the date in the field matters, not the day it was saved', !mailed('d2@example.com', 'Renewal soon') && !mailed('d3@example.com', 'Renewal soon'));
check('a date that is today starts an "on the day" automation, yesterday does not', !!(await until(() => mailed('d4@example.com', 'Expires today'))) && !mailed('d5@example.com', 'Expires today'));
check('a birthday today starts the yearly automation, tomorrow and a badly written date do not', !!(await until(() => mailed('d6@example.com', 'Happy birthday'))) && !mailed('d7@example.com', 'Happy birthday') && !mailed('d8@example.com', 'Happy birthday'));
await sleep(3500);
check('each person starts once, even though the scan can run again', (await stat(dateAuto.id)).enrolled === 1 && (await stat(birthAuto.id)).enrolled === 1);
const reasons = await call('POST', `${W}/automations/${dateAuto.id}/status`, { token: A, body: { active: false } });
await call('POST', `${W}/automations/${dateAuto.id}/status`, { token: A, body: { active: true } });
await sleep(3500);
check('switching it off and on again does not start the same people again', (await stat(dateAuto.id)).enrolled === 1 && (log().match(/d1@example.com :: Renewal soon/g) || []).length === 1);

/* ---------- branches ---------- */
await call('POST', `${W}/contacts`, { token: A, body: { email: 'br1@example.com', first_name: 'Opener', list_id: XL.id } });
await call('POST', `${W}/contacts`, { token: A, body: { email: 'br2@example.com', first_name: 'Ignorer', list_id: XL.id } });
const offer1 = await until(() => tokenFor('br1@example.com', 'X Offer'));
await openMail(offer1);
check('the first email goes to both', !!(await until(() => mailed('br2@example.com', 'X Offer'))));
check('the person who opened gets the thank you branch', !!(await until(() => mailed('br1@example.com', 'X Thanks'))));
check('the person who did not open gets the nudge branch', !!(await until(() => mailed('br2@example.com', 'X Nudge'))));
await sleep(2500);
check('and neither gets the other branch', !mailed('br1@example.com', 'X Nudge') && !mailed('br2@example.com', 'X Thanks'));
const b1 = await until(async () => { const r = await runOf(branch.id, 'br1@example.com'); return r?.status === 'completed' ? r : null; });
const b2 = await until(async () => { const r = await runOf(branch.id, 'br2@example.com'); return r?.status === 'completed' ? r : null; });
check('both runs finish', !!b1 && !!b2 && b1.ended_reason === 'finished' && b2.ended_reason === 'finished', JSON.stringify([b1, b2]));
check('the tag step ran at the end of both branches', (await cOf('br1@example.com')).tags.includes('x-done') && (await cOf('br2@example.com')).tags.includes('x-done'));
const bs = await stat(branch.id);
check('stats count only the emails as steps', bs.steps === 3 && bs.step_count === 5 && bs.sent === 4, JSON.stringify(bs));

/* ---------- other conditions ---------- */
const c1 = await condAuto('Cond tag', cond('has_tag', 'vip'), ['T1 first', 'T1 second']);
const c2 = await condAuto('Cond attr', cond('attr_equals', 'pro', 'plan'), ['A1 first', 'A1 second']);
const c3 = await condAuto('Cond list', cond('on_list', GL.id), ['O1 first', 'O1 second']);
const cp = await call('POST', `${W}/contacts`, { token: A, body: { email: 'cd1@example.com', first_name: 'Cd1', tags: ['vip'], attributes: { plan: 'pro' } } });
await call('POST', `${W}/profile/${(await cOf('cd1@example.com')).id}/lists`, { token: A, body: { list_id: GL.id } });
await call('POST', `${W}/contacts`, { token: A, body: { email: 'cd2@example.com', first_name: 'Cd2', attributes: { plan: 'free' } } });
for (const e of ['cd1@example.com', 'cd2@example.com']) await call('POST', `${W}/profile/${(await cOf(e)).id}/lists`, { token: A, body: { list_id: YL.id } });
await until(() => mailed('cd2@example.com', 'T1 second') && mailed('cd2@example.com', 'A1 second') && mailed('cd2@example.com', 'O1 second'));
check('someone with the tag, the field value or the list takes the "yes" way and stops', mailed('cd1@example.com', 'T1 first') && !mailed('cd1@example.com', 'T1 second') && !mailed('cd1@example.com', 'A1 second') && !mailed('cd1@example.com', 'O1 second'));
check('someone without carries on to the next email', mailed('cd2@example.com', 'T1 second') && mailed('cd2@example.com', 'A1 second') && mailed('cd2@example.com', 'O1 second'));
const ended = await runOf(c1.id, 'cd1@example.com');
check('a run stopped by a condition says so', ended?.status === 'completed' && ended.ended_reason === 'condition', JSON.stringify(ended));

/* ---------- exit goals ---------- */
const gtL = goalTagList;
await call('POST', `${W}/contacts`, { token: A, body: { email: 'gt1@example.com', first_name: 'Buyer', list_id: gtL } });
await call('POST', `${W}/contacts`, { token: A, body: { email: 'gt2@example.com', first_name: 'Browser', list_id: gtL } });
await call('POST', `${W}/contacts`, { token: A, body: { email: 'gl1@example.com', first_name: 'Joiner', list_id: goalListL.id } });
await call('POST', `${W}/contacts`, { token: A, body: { email: 'gk1@example.com', first_name: 'Clicker', list_id: goalLinkL.id } });
await until(() => mailed('gt1@example.com', 'G1 first') && mailed('gl1@example.com', 'GL first') && mailed('gk1@example.com', 'L1 first'));
await setTags('gt1@example.com', ['bought']);
await call('POST', `${W}/profile/${(await cOf('gl1@example.com')).id}/lists`, { token: A, body: { list_id: GL.id } });
const lk = await until(() => tokenFor('gk1@example.com', 'L1 first'));
await sleep(5200);
await clickUrl(lk, 'https://shop.example/Checkout/now');
check('someone who reaches the tag goal gets nothing more', !!(await until(async () => (await runOf(goalTag.id, 'gt1@example.com'))?.ended_reason === 'goal')) && !mailed('gt1@example.com', 'G1 second'));
check('someone who has not reached it still gets the next email', !!(await until(() => mailed('gt2@example.com', 'G1 second'))));
check('joining the goal list ends the sequence', !!(await until(async () => (await runOf(goalList.id, 'gl1@example.com'))?.ended_reason === 'goal')) && !mailed('gl1@example.com', 'GL second'));
check('clicking the goal link ends the sequence', !!(await until(async () => (await runOf(goalLink.id, 'gk1@example.com'))?.ended_reason === 'goal')) && !mailed('gk1@example.com', 'L1 second'));
const gs = await stat(goalTag.id);
check('the automation counts how many reached the goal', gs.goal_reached === 1, JSON.stringify(gs));
const full = (await call('GET', `${W}/automations/${goalTag.id}`, { token: A })).data;
check('the saved automation reports its trigger, goal and steps', full.goal_type === 'tag' && full.goal_value === 'bought' && full.trigger_type === 'list_join' && full.steps.length === 2 && full.steps[0].kind === 'email', JSON.stringify(full).slice(0, 300));
const brFull = (await call('GET', `${W}/automations/${branch.id}`, { token: A })).data;
check('a branching automation reads back exactly as saved', brFull.steps[1].kind === 'condition' && brFull.steps[1].cond.type === 'opened' && brFull.steps[1].yes_to === 3 && brFull.steps[1].no_to === 2 && brFull.steps[2].yes_to === 4 && brFull.steps[4].tag_value === 'x-done');

/* ---------- editing keeps things safe ---------- */
const edited = await call('PUT', `${W}/automations/${branch.id}`, { token: A, body: { name: 'Branch', trigger_type: 'list_join', list_id: XL.id, active: true, steps: [step('X Offer'), step('X Second')] } });
check('steps can be removed on edit and the old ones are gone', edited.status === 200 && (await call('GET', `${W}/automations/${branch.id}`, { token: A })).data.steps.length === 2);
const switched = await call('PUT', `${W}/automations/${branch.id}`, { token: A, body: { name: 'Branch', trigger_type: 'tag_added', trigger_value: 'switched', active: true, steps: [step('X Offer')] } });
check('the trigger can be changed on an existing automation', switched.status === 200 && switched.data.trigger_type === 'tag_added' && switched.data.trigger_value === 'switched');
check('another workspace cannot read or change it', (await call('GET', `/api/workspaces/${made.data.id}/automations/${branch.id}`, { token: O })).status === 404);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
