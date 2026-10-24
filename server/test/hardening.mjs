// Run against a live server on an empty database with FORCE_PROVIDER=console.
// Covers: sign out everywhere, login lockout, idempotency keys, audit log, viewer role, owner-only actions,
// undo window for deleted lists and templates, contact paging, readiness.
const BASE = process.env.BASE || 'http://localhost:4000';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
async function call(method, path, { token, key, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => ({})) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', '/api/workspaces/1', { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: 'Abuja' } });
const made = await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'o@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } });
const W2 = made.data.id;
const O = (await call('POST', '/api/auth/login', { body: { email: 'o@acme.ng', password: 'acme-pass-99' } })).data.token;

// readiness and request ids
const ready = await call('GET', '/health/ready');
check('readiness proves the database answers', ready.status === 200 && ready.data.ok === true);
check('every response carries a request id', !!ready.headers.get('x-request-id'));

// sign out everywhere
const second = (await call('POST', '/api/auth/login', { body: { email: 'o@acme.ng', password: 'acme-pass-99' } })).data.token;
await sleep(1100);
check('both sessions work before', (await call('GET', '/api/auth/me', { token: O })).status === 200 && (await call('GET', '/api/auth/me', { token: second })).status === 200);
const out = await call('POST', '/api/auth/logout-all', { token: O });
check('sign out everywhere returns a fresh token', out.status === 200 && !!out.data.token);
check('the other session is dead', (await call('GET', '/api/auth/me', { token: second })).status === 401);
check('the old token of the caller is dead too', (await call('GET', '/api/auth/me', { token: O })).status === 401);
const O2 = out.data.token;
check('the caller stays signed in with the fresh token', (await call('GET', '/api/auth/me', { token: O2 })).status === 200);

// admin kill switch
const ownerId = (await call('GET', '/api/auth/me', { token: O2 })).data.user.id;
await sleep(1100);
check('non-admin cannot revoke sessions', (await call('POST', `/api/admin/users/${ownerId}/revoke-sessions`, { token: O2 })).status === 403);
check('admin can revoke every session of a user', (await call('POST', `/api/admin/users/${ownerId}/revoke-sessions`, { token: A })).status === 200);
check('revoked session is rejected', (await call('GET', '/api/auth/me', { token: O2 })).status === 401);
const OT = (await call('POST', '/api/auth/login', { body: { email: 'o@acme.ng', password: 'acme-pass-99' } })).data.token;
check('signing in again works', !!OT);

// api keys and exports are owner only; viewers are read only
const inv = await call('POST', `/api/workspaces/${W2}/members`, { token: OT, body: { email: 'mate@acme.ng' } });
const inv2 = await call('POST', `/api/workspaces/${W2}/members`, { token: OT, body: { email: 'eyes@acme.ng', role: 'viewer' } });
check('owner invites a teammate and a viewer', inv.status === 200 && inv2.status === 200);
const setPw = async (link, pw) => {
  const token = new URL(link).searchParams.get('token');
  return call('POST', '/api/auth/reset', { body: { token, password: pw } });
};
await setPw(inv.data.invite_link, 'mate-pass-123');
await setPw(inv2.data.invite_link, 'eyes-pass-123');
const M = (await call('POST', '/api/auth/login', { body: { email: 'mate@acme.ng', password: 'mate-pass-123' } })).data.token;
const V = (await call('POST', '/api/auth/login', { body: { email: 'eyes@acme.ng', password: 'eyes-pass-123' } })).data.token;
check('teammate cannot create API keys', (await call('POST', `/api/workspaces/${W2}/api-keys`, { token: M, body: { name: 'x' } })).status === 403);
check('teammate cannot export contacts', (await call('GET', `/api/workspaces/${W2}/contacts/export`, { token: M })).status === 403);
check('teammate cannot change the provider key', (await call('PUT', `/api/workspaces/${W2}`, { token: M, body: { provider_api_key: 're_teammate_key_123' } })).status === 403);
check('teammate can still change ordinary settings', (await call('PUT', `/api/workspaces/${W2}`, { token: M, body: { from_name: 'Acme News' } })).status === 200);
check('teammate can still add contacts', (await call('POST', `/api/workspaces/${W2}/contacts`, { token: M, body: { email: 'kemi@example.com' } })).status === 200);
check('viewer can read contacts', (await call('GET', `/api/workspaces/${W2}/contacts`, { token: V })).status === 200);
check('viewer cannot add contacts', (await call('POST', `/api/workspaces/${W2}/contacts`, { token: V, body: { email: 'nope@example.com' } })).status === 403);
check('viewer cannot create lists', (await call('POST', `/api/workspaces/${W2}/lists`, { token: V, body: { name: 'x' } })).status === 403);
check('viewer cannot export', (await call('GET', `/api/workspaces/${W2}/contacts/export`, { token: V })).status === 403);
check('owner can export', (await call('GET', `/api/workspaces/${W2}/contacts/export`, { token: OT })).status === 200);

// undo window
const list = (await call('POST', `/api/workspaces/${W2}/lists`, { token: OT, body: { name: 'Customers' } })).data;
const kemi = (await call('POST', `/api/workspaces/${W2}/contacts`, { token: OT, body: { email: 'chidi@example.com', list_id: list.id } })).data;
const tpl = (await call('POST', `/api/workspaces/${W2}/templates`, { token: OT, body: { name: 'Welcome', subject: 'Hi', html: '<p>Hello</p>' } })).data;
await call('DELETE', `/api/workspaces/${W2}/templates/${tpl.id}`, { token: OT });
await call('DELETE', `/api/workspaces/${W2}/lists/${list.id}`, { token: OT });
const gone = await call('GET', `/api/workspaces/${W2}/deleted`, { token: OT });
check('deleted list and template are held for undo', gone.data.length === 2, JSON.stringify(gone.data));
const tRec = gone.data.find((d) => d.kind === 'template'), lRec = gone.data.find((d) => d.kind === 'list');
const back = await call('POST', `/api/workspaces/${W2}/deleted/${tRec.id}/restore`, { token: OT });
check('template comes back with its content', back.status === 200 && back.data.name === 'Welcome' && back.data.html === '<p>Hello</p>', JSON.stringify(back.data));
const lback = await call('POST', `/api/workspaces/${W2}/deleted/${lRec.id}/restore`, { token: OT });
check('list comes back', lback.status === 200 && lback.data.name === 'Customers');
const members = await call('GET', `/api/workspaces/${W2}/contacts?listId=${lback.data.id}`, { token: OT });
check('list members come back too', members.data.some((c) => c.id === kemi.id), JSON.stringify(members.data).slice(0, 200));
check('restoring twice fails cleanly', (await call('POST', `/api/workspaces/${W2}/deleted/${tRec.id}/restore`, { token: OT })).status === 404);
check('another workspace cannot restore it', (await call('POST', `/api/workspaces/1/deleted/${tRec.id}/restore`, { token: A })).status === 404);

// paging
for (let i = 0; i < 7; i++) await call('POST', `/api/workspaces/${W2}/contacts`, { token: OT, body: { email: `page${i}@example.com` } });
const p1 = await call('GET', `/api/workspaces/${W2}/contacts?limit=5`, { token: OT });
const cur = p1.headers.get('x-next-cursor');
check('first page has a next cursor', p1.data.length === 5 && !!cur);
const p2 = await call('GET', `/api/workspaces/${W2}/contacts?limit=5&cursor=${cur}`, { token: OT });
check('second page continues without overlap', p2.data.length > 0 && !p2.data.some((c) => p1.data.some((d) => d.id === c.id)) && Math.max(...p2.data.map((c) => c.id)) < Number(cur) + 1);

// idempotency
const key = (await call('POST', `/api/workspaces/${W2}/api-keys`, { token: OT, body: { name: 'k' } })).data.key;
await call('PUT', `/api/workspaces/${W2}`, { token: OT, body: { from_email: 'hello@acme.ng', footer_address: 'Lagos' } });
const mail = { to: 'chidi@example.com', subject: 'Receipt', html: '<p>Paid</p>' };
const i1 = await call('POST', '/v1/emails', { key, body: mail, headers: { 'Idempotency-Key': 'order-1001-receipt' } });
const i2 = await call('POST', '/v1/emails', { key, body: mail, headers: { 'Idempotency-Key': 'order-1001-receipt' } });
check('first request sends', i1.status === 200 && i1.data.status === 'sent', JSON.stringify(i1.data));
check('retry replays the same answer', i2.status === 200 && i2.data.id === i1.data.id && i2.headers.get('idempotent-replayed') === 'true');
const sentCount = (await call('GET', `/api/workspaces/${W2}/api-emails`, { token: OT })).data.length;
check('the retry did not send a second email', sentCount === 1, String(sentCount));
check('same key with a different body is refused', (await call('POST', '/v1/emails', { key, body: { ...mail, subject: 'Other' }, headers: { 'Idempotency-Key': 'order-1001-receipt' } })).status === 422);
check('a malformed key is rejected', (await call('POST', '/v1/emails', { key, body: mail, headers: { 'Idempotency-Key': 'x' } })).status === 400);
const noKey1 = await call('POST', '/v1/emails', { key, body: mail });
check('no header behaves as before', noKey1.status === 200 && noKey1.data.id !== i1.data.id);
const racing = await Promise.all([1, 2, 3].map(() => call('POST', '/v1/emails', { key, body: { ...mail, subject: 'Race' }, headers: { 'Idempotency-Key': 'race-key-0001' } })));
const sentRace = racing.filter((r) => r.status === 200 && !r.headers.get('idempotent-replayed')).length;
check('three simultaneous clicks send exactly once', sentRace === 1, racing.map((r) => r.status).join(','));

// audit log
const log = await call('GET', `/api/workspaces/${W2}/audit`, { token: OT });
const actions = log.data.map((r) => r.action);
check('audit log is owner only', (await call('GET', `/api/workspaces/${W2}/audit`, { token: M })).status === 403 && log.status === 200);
check('audit log records key creation, deletes, restores and exports',
  ['apikey.created', 'list.deleted', 'template.deleted', 'record.restored', 'contacts.exported'].every((a) => actions.includes(a)), actions.join(','));
check('audit log never holds secrets or full keys', !JSON.stringify(log.data).includes(key) && !JSON.stringify(log.data).includes('re_teammate_key_123'));
check('audit log is per workspace', !(await call('GET', '/api/workspaces/1/audit', { token: A })).data.some((r) => r.action === 'apikey.created'));

// lockout: stops strangers, never the person who normally signs in from this address
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
let locked = 0;
for (let i = 0; i < 24; i++) {
  const r = await call('POST', '/api/auth/login', { body: { email: 'target@acme.ng', password: 'wrong-' + i } });
  if (r.status === 429) { locked++; break; }
}
check('rate limits stop password guessing', locked === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
