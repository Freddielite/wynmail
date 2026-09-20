// Run against a live server on an empty database with FORCE_PROVIDER=console.
const BASE = process.env.BASE || 'http://localhost:4000';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
async function call(method, path, { token, key, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', '/api/workspaces/1', { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: 'Abuja' } });
const other = await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'o@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } });

// keys
const made = await call('POST', '/api/workspaces/1/api-keys', { token: A, body: { name: 'Website' } });
const KEY = made.data.key;
check('key is created and shown once', made.status === 200 && KEY?.startsWith('wm_'));
const listed = await call('GET', '/api/workspaces/1/api-keys', { token: A });
check('key list never contains the full key', !JSON.stringify(listed.data).includes(KEY) && listed.data[0].prefix === KEY.slice(0, 10));
check('no key is rejected', (await call('GET', '/v1/lists')).status === 401);
check('garbage key is rejected', (await call('GET', '/v1/lists', { key: 'wm_' + 'x'.repeat(32) })).status === 401);
check('valid key works', (await call('GET', '/v1/lists', { key: KEY })).status === 200);

// contacts
const c1 = await call('POST', '/v1/contacts', { key: KEY, body: { email: 'Ada@Example.com', first_name: 'Ada', list: 'Newsletter', attributes: { company: 'Zenith' } } });
check('contact added and list created by name', c1.status === 200 && c1.data.email === 'ada@example.com' && c1.data.list_ids.length === 1, JSON.stringify(c1.data));
const c2 = await call('POST', '/v1/contacts', { key: KEY, body: { email: 'ada@example.com', last_name: 'Obi', list: 'Newsletter' } });
check('adding again updates instead of duplicating', c2.data.id === c1.data.id && c2.data.last_name === 'Obi' && c2.data.list_ids.length === 1);
check('invalid email rejected', (await call('POST', '/v1/contacts', { key: KEY, body: { email: 'nope' } })).status === 400);
check('unknown list id rejected', (await call('POST', '/v1/contacts', { key: KEY, body: { email: 'b@example.com', list_ids: [999] } })).status === 400);
const un = await call('POST', '/v1/contacts/ada%40example.com/unsubscribe', { key: KEY });
check('unsubscribe works', un.data.status === 'unsubscribed');
const re = await call('POST', '/v1/contacts', { key: KEY, body: { email: 'ada@example.com', first_name: 'Ada' } });
check('re-adding does not resubscribe an unsubscribed contact', re.data.status === 'unsubscribed');
check('unknown contact is 404', (await call('GET', '/v1/contacts/nobody%40example.com', { key: KEY })).status === 404);

// single email
const okMail = await call('POST', '/v1/emails', { key: KEY, body: { to: 'ada@example.com', subject: 'Hi {{first_name}}', html: '<p>Hello {{first_name}}</p>', variables: { first_name: 'Ada' } } });
check('single email sends', okMail.status === 200 && okMail.data.status === 'sent', JSON.stringify(okMail.data));
check('bad recipient rejected', (await call('POST', '/v1/emails', { key: KEY, body: { to: 'a,b@x.com', subject: 's', html: 'x' } })).status === 400);
check('missing content rejected', (await call('POST', '/v1/emails', { key: KEY, body: { to: 'a@x.com', subject: 's' } })).status === 400);
const recent = await call('GET', '/api/workspaces/1/api-emails', { token: A });
check('recent API emails are logged', recent.data.length === 1 && recent.data[0].status === 'sent');

// tenant isolation
const OC = (await call('POST', '/api/auth/login', { body: { email: 'o@acme.ng', password: 'acme-pass-99' } })).data.token;
const W2 = other.data.id;
const K2 = (await call('POST', `/api/workspaces/${W2}/api-keys`, { token: OC, body: { name: 'Acme' } })).data.key;
const l2 = await call('GET', '/v1/lists', { key: K2 });
check('a key only sees its own workspace', l2.data.data.length === 0);
const noSender = await call('POST', '/v1/emails', { key: K2, body: { to: 'a@x.com', subject: 's', html: 'x' } });
check('workspace without an approved sender cannot send', noSender.status === 400);
check('client cannot list another workspace keys', (await call('GET', '/api/workspaces/1/api-keys', { token: OC })).status === 403);

// revoke
const id = listed.data[0].id;
await call('DELETE', `/api/workspaces/1/api-keys/${id}`, { token: A });
check('revoked key stops working at once', (await call('GET', '/v1/lists', { key: KEY })).status === 401);

// daily cap
const K3 = (await call('POST', '/api/workspaces/1/api-keys', { token: A, body: { name: 'cap' } })).data.key;
await call('PUT', `/api/admin/workspaces/1`, { token: A, body: { daily_limit: 1 } });
const capped = await call('POST', '/v1/emails', { key: K3, body: { to: 'ada@example.com', subject: 's', html: 'x' } });
check('daily cap is enforced for API sends', capped.status === 429, String(capped.status));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
