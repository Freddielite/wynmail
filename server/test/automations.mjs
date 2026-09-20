// Automations. Fresh database, FORCE_PROVIDER=console, AUTOMATION_MINUTE_MS=1000 (one "minute" = one second), LOG=<server log>.
import fs from 'fs';

const BASE = process.env.BASE || 'http://localhost:4000';
const LOG = process.env.LOG;
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 14000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* keep trying */ } await sleep(300); } return false; }

async function call(method, path, { token, key, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const logText = () => fs.readFileSync(LOG, 'utf8');
const mailedTo = (email, subject) => logText().includes(`-> ${email} :: ${subject}`);
const pageT = async (slug) => (await (await fetch(`${BASE}/f/${slug}`)).text()).match(/name="t" value="([^"]+)"/)[1];
const confirmToken = (email) => { const l = logText().split('\n').filter((x) => x.includes(`[confirm email] ${email} |`)); const m = l.length && l[l.length - 1].match(/\/confirm\/([\w-]+)/); return m ? m[1] : null; };

const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', '/api/workspaces/1', { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: 'Abuja' } });
const mk = async (name) => (await call('POST', '/api/workspaces/1/lists', { token: A, body: { name } })).data;
const [L, L2, L3, L4, L5] = [await mk('L'), await mk('L2'), await mk('L3'), await mk('L4'), await mk('L5')];
const made = await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'owner@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } });
const W2 = made.data.id;
const O = (await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'acme-pass-99' } })).data.token;
const list2 = (await call('POST', `/api/workspaces/${W2}/lists`, { token: O, body: { name: 'Acme list' } })).data;
const step = (subject, delay = 0, html = '<p>Hi {{first_name}}</p>') => ({ subject, delay_minutes: delay, html });
const auto = (over) => ({ name: 'Auto', list_id: L.id, active: true, include_imports: false, steps: [step('S1')], ...over });
const create = (body, token = A, ws = 1) => call('POST', `/api/workspaces/${ws}/automations`, { token, body });
const stats = async (id) => (await call('GET', '/api/workspaces/1/automations', { token: A })).data.find((a) => a.id === id);
const addContact = (email, listId, first = 'Test') => call('POST', '/api/workspaces/1/contacts', { token: A, body: { email, first_name: first, list_id: listId } });

// validation
check('an automation needs at least one email', (await create(auto({ steps: [] }))).status === 400);
check('every email needs a subject', (await create(auto({ steps: [step('')] }))).status === 400);
check('every email needs content', (await create(auto({ steps: [step('S', 0, '   ')] }))).status === 400);
check('at most ten emails', (await create(auto({ steps: Array.from({ length: 11 }, (_, i) => step('S' + i)) }))).status === 400);
check('delays cannot be negative', (await create(auto({ steps: [step('S', -5)] }))).status === 400);
check('an automation needs a list', (await create(auto({ list_id: undefined }))).status === 400);
check('an automation cannot use another workspace list', (await create(auto({ list_id: L.id, active: false }), O, W2)).status === 400);
check('turning on needs an approved sender', (await create(auto({ list_id: list2.id }), O, W2)).status === 400);
check('a paused automation can be saved without a sender', (await create(auto({ list_id: list2.id, active: false }), O, W2)).status === 200);

// welcome sequence: manual add, two emails
const a = (await create(auto({ name: 'Welcome', steps: [step('Welcome {{first_name}}', 0), step('Tips for {{first_name}}', 2)] }))).data;
await addContact('ada@example.com', L.id, 'Ada');
check('the first email sends straight away, merged', !!(await until(() => mailedTo('ada@example.com', 'Welcome Ada'))));
check('the second email waits for its delay and then sends', !!(await until(() => mailedTo('ada@example.com', 'Tips for Ada'))));
const s1 = await until(async () => { const s = await stats(a.id); return s.completed === 1 && s.sent === 2 ? s : null; });
check('stats show one person completed and two emails sent', !!s1 && s1.enrolled === 1 && s1.in_progress === 0, JSON.stringify(s1));
const runs = (await call('GET', `/api/workspaces/1/automations/${a.id}/runs`, { token: A })).data;
check('people panel shows the run as completed', runs.length === 1 && runs[0].email === 'ada@example.com' && runs[0].status === 'completed' && runs[0].total_steps === 2, JSON.stringify(runs));

// imports do not surprise-enroll
await call('POST', '/api/workspaces/1/contacts/import', { token: A, body: { list_id: L.id, csv: 'email,first_name\nbob@example.com,Bob' } });
await sleep(1500);
check('people added by CSV import are not enrolled by default', (await stats(a.id)).enrolled === 1 && !mailedTo('bob@example.com', 'Welcome Bob'));
await call('PUT', `/api/workspaces/1/automations/${a.id}`, { token: A, body: { ...auto({ name: 'Welcome', include_imports: true, steps: [step('Welcome {{first_name}}', 0), step('Tips for {{first_name}}', 2)] }) } });
await call('POST', '/api/workspaces/1/contacts/import', { token: A, body: { list_id: L.id, csv: 'email,first_name\ncy@example.com,Cy' } });
check('the import option enrolls imported people', !!(await until(() => mailedTo('cy@example.com', 'Welcome Cy'))));
check('turning it on did not retroactively enroll earlier imports', !mailedTo('bob@example.com', 'Welcome Bob'));
await addContact('ada@example.com', L.id, 'Ada');
await sleep(1200);
check('joining the same list again never enrolls twice', (await stats(a.id)).enrolled === 2);

// unsubscribing in the middle of a sequence, and the API path
const key = (await call('POST', '/api/workspaces/1/api-keys', { token: A, body: { name: 'k' } })).data.key;
const b = (await create(auto({ name: 'Onboarding', list_id: L2.id, steps: [step('B1', 0), step('B2', 4)] }))).data;
await call('POST', '/v1/contacts', { key, body: { email: 'dan@example.com', first_name: 'Dan', list_ids: [L2.id] } });
check('contacts added through the API are enrolled', !!(await until(() => mailedTo('dan@example.com', 'B1'))));
await call('POST', '/v1/contacts/dan%40example.com/unsubscribe', { key });
await sleep(6000);
const sb = await stats(b.id);
check('unsubscribing stops the rest of the sequence', !mailedTo('dan@example.com', 'B2') && sb.sent === 1, JSON.stringify(sb));
check('the stopped run is cancelled', (await call('GET', `/api/workspaces/1/automations/${b.id}/runs`, { token: A })).data[0].status === 'cancelled');
await call('POST', '/v1/contacts', { key, body: { email: 'eve@example.com', list_ids: [] } });
await call('POST', '/v1/contacts/eve%40example.com/unsubscribe', { key });
await call('POST', '/v1/contacts', { key, body: { email: 'eve@example.com', list_ids: [L2.id] } });
await sleep(1500);
check('people who are not subscribed are never enrolled', (await stats(b.id)).enrolled === 1);

// pausing and resuming
const c = (await create(auto({ name: 'Drip', list_id: L3.id, steps: [step('C1', 0), step('C2', 3)] }))).data;
await addContact('fay@example.com', L3.id, 'Fay');
await until(() => mailedTo('fay@example.com', 'C1'));
await call('POST', `/api/workspaces/1/automations/${c.id}/status`, { token: A, body: { active: false } });
await addContact('gus@example.com', L3.id, 'Gus');
await sleep(4500);
const paused = await stats(c.id);
check('a paused automation sends nothing and enrolls nobody', !mailedTo('fay@example.com', 'C2') && paused.enrolled === 1 && paused.status === 'paused', JSON.stringify(paused));
await call('POST', `/api/workspaces/1/automations/${c.id}/status`, { token: A, body: { active: true } });
check('resuming continues where people left off', !!(await until(() => mailedTo('fay@example.com', 'C2'))));
check('people who joined while paused are not enrolled afterwards', !mailedTo('gus@example.com', 'C1'));

// forms: welcome after confirming
const d = (await create(auto({ name: 'Form welcome', list_id: L4.id, steps: [step('Welcome from the form')] }))).data;
const form = (await call('POST', '/api/workspaces/1/forms', { token: A, body: { name: 'F', list_id: L4.id, consent_text: 'I agree to receive emails.' } })).data;
const t = await pageT(form.slug);
await sleep(2300);
await fetch(`${BASE}/f/${form.slug}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'hal@example.com', consent: 'on', t }) });
await until(() => confirmToken('hal@example.com'));
await sleep(1500);
check('a pending signup is not enrolled', (await stats(d.id)).enrolled === 0 && !mailedTo('hal@example.com', 'Welcome from the form'));
await fetch(`${BASE}/confirm/${confirmToken('hal@example.com')}`, { method: 'POST' });
check('confirming a signup starts the welcome email', !!(await until(() => mailedTo('hal@example.com', 'Welcome from the form'))));

// editing keeps step ids and stats
const before = (await call('GET', `/api/workspaces/1/automations/${a.id}`, { token: A })).data;
await call('PUT', `/api/workspaces/1/automations/${a.id}`, { token: A, body: auto({ name: 'Welcome', include_imports: true, steps: [step('Welcome again {{first_name}}', 0), step('Tips for {{first_name}}', 2), step('Third', 5)] }) });
const after = (await call('GET', `/api/workspaces/1/automations/${a.id}`, { token: A })).data;
check('editing keeps existing step ids and their stats, and adds new steps', after.steps.length === 3 && after.steps[0].id === before.steps[0].id && after.steps[1].id === before.steps[1].id && after.steps[0].subject === 'Welcome again {{first_name}}' && after.steps[0].sent >= 1, JSON.stringify(after.steps.map((s) => [s.id, s.subject, s.sent])));
await call('PUT', `/api/workspaces/1/automations/${a.id}`, { token: A, body: auto({ name: 'Welcome', include_imports: true, steps: [step('Only one')] }) });
check('removing emails removes them', (await call('GET', `/api/workspaces/1/automations/${a.id}`, { token: A })).data.steps.length === 1);

// isolation
check('another workspace cannot see these automations', (await call('GET', `/api/workspaces/${W2}/automations/${a.id}`, { token: O })).status === 404 && (await call('GET', `/api/workspaces/${W2}/automations`, { token: O })).data.every((x) => x.workspace_id === W2));
check('another workspace cannot change them', (await call('PUT', `/api/workspaces/${W2}/automations/${a.id}`, { token: O, body: auto({ list_id: list2.id, active: false }) })).status === 404
  && (await call('POST', `/api/workspaces/${W2}/automations/${a.id}/status`, { token: O, body: { active: false } })).status === 404
  && (await call('DELETE', `/api/workspaces/${W2}/automations/${a.id}`, { token: O })).status === 200 && !!(await call('GET', `/api/workspaces/1/automations/${a.id}`, { token: A })).data.id);
check('another workspace cannot read the people', (await call('GET', `/api/workspaces/${W2}/automations/${a.id}/runs`, { token: O })).data.length === 0);
check('cross-workspace access is refused outright', (await call('GET', '/api/workspaces/1/automations', { token: O })).status === 403);

// delete
await call('DELETE', `/api/workspaces/1/automations/${c.id}`, { token: A });
check('deleting an automation removes it', (await call('GET', `/api/workspaces/1/automations/${c.id}`, { token: A })).status === 404);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
