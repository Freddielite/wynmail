// Retry endpoint through the real routes (the queue behaviour itself is in queue-resilience.mjs).
// Run against a live server on an empty database with FORCE_PROVIDER=console.
const BASE = process.env.BASE || 'http://localhost:4000';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
async function call(method, path, { token, key, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', '/api/workspaces/1', { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: 'Abuja' } });
const KEY = (await call('POST', '/api/workspaces/1/api-keys', { token: A, body: { name: 'Site' } })).data.key;
const list = (await call('POST', '/api/workspaces/1/lists', { token: A, body: { name: 'News' } })).data;
for (const e of ['a@example.com', 'b@example.com']) await call('POST', '/v1/contacts', { key: KEY, body: { email: e, list_ids: [list.id] } });
const camp = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { subject: 'Hello', html: '<p>Hi</p>', list_id: list.id } })).data;
await call('POST', `/api/workspaces/1/campaigns/${camp.id}/send`, { token: A, body: {} });
let state;
for (let i = 0; i < 40; i++) { state = (await call('GET', `/v1/campaigns/${camp.id}`, { key: KEY })).data; if (state.status === 'sent') break; await sleep(500); }
check('the campaign went out', state.status === 'sent' && state.sent === 2, JSON.stringify(state));
check('campaign status carries failed and waiting counts', state.failed === 0 && state.waiting === 0, JSON.stringify(state));

const r1 = await call('POST', `/v1/campaigns/${camp.id}/retry`, { key: KEY });
check('retry through the API: nothing to put back, and says so', r1.status === 200 && r1.data.requeued === 0, JSON.stringify(r1));
const r2 = await call('POST', `/api/workspaces/1/campaigns/${camp.id}/retry`, { token: A, body: {} });
check('retry from the dashboard works the same', r2.status === 200 && r2.data.requeued === 0, JSON.stringify(r2));
check('nobody got a second copy', (await call('GET', `/v1/campaigns/${camp.id}`, { key: KEY })).data.sent === 2);
check('an unknown campaign is a 404', (await call('POST', '/v1/campaigns/99999/retry', { key: KEY })).status === 404);
check('a bad id is a 400', (await call('POST', '/v1/campaigns/abc/retry', { key: KEY })).status === 400);
check('no key is refused', (await call('POST', `/v1/campaigns/${camp.id}/retry`)).status === 401);
const draft = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { subject: 'Draft', html: '<p>x</p>', list_id: list.id } })).data;
const r3 = await call('POST', `/v1/campaigns/${draft.id}/retry`, { key: KEY });
check('a draft cannot be retried', r3.status === 400 && /has been sent/.test(r3.data.error || ''), JSON.stringify(r3));
const listed = (await call('GET', '/api/workspaces/1/campaigns', { token: A })).data;
const row = (Array.isArray(listed) ? listed : listed.campaigns || []).find((c) => c.id === camp.id);
check('the dashboard list carries failed and stuck counts', row && row.failed === 0 && row.stuck === 0, JSON.stringify(row));
const ready = await call('GET', '/health/ready');
check('readiness reports the worker as running', ready.status === 200 && ready.data.queue === 'running', JSON.stringify(ready));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
