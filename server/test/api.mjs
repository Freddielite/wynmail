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

// campaign stats endpoints
const cl = (await call('POST', '/api/workspaces/1/lists', { token: A, body: { name: 'Stats list' } })).data;
await call('POST', '/v1/contacts', { key: KEY, body: { email: 'stat@example.com', first_name: 'Stat', list_ids: [cl.id] } });
const cc = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { subject: 'Stats', html: '<p>Hi</p>', list_id: cl.id } })).data;
await call('POST', `/api/workspaces/1/campaigns/${cc.id}/send`, { token: A });
await new Promise((r) => setTimeout(r, 4500));
const camps = await call('GET', '/v1/campaigns', { key: KEY });
const mine = camps.data.data?.find((c) => c.id === cc.id);
check('campaign list endpoint returns stats', camps.status === 200 && mine?.total === 1 && mine.sent === 1 && 'unsubscribed' in mine && 'bounced' in mine, JSON.stringify(camps.data).slice(0, 300));
const tok = (await call('GET', `/api/workspaces/1/campaigns/${cc.id}/messages`, { token: A })).data[0].token;
await fetch(`${BASE}/t/u/${tok}`, { method: 'POST' });
const one1 = await call('GET', `/v1/campaigns/${cc.id}`, { key: KEY });
check('single campaign endpoint counts unsubscribes', one1.status === 200 && one1.data.unsubscribed === 1, JSON.stringify(one1.data));
check('unknown campaign is a 404', (await call('GET', '/v1/campaigns/99999', { key: KEY })).status === 404);

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

// list stats, recent contacts, create and send a campaign over the API
const KP = (await call('POST', '/api/workspaces/1/api-keys', { token: A, body: { name: 'posts' } })).data.key;
const pl = (await call('POST', '/api/workspaces/1/lists', { token: A, body: { name: 'Posts list' } })).data;
await call('POST', '/v1/contacts', { key: KP, body: { email: 'reader@example.com', first_name: 'Reader', list_ids: [pl.id] } });
const st = await call('GET', `/v1/lists/${pl.id}/stats`, { key: KP });
check('list stats count subscribers', st.status === 200 && st.data.subscribed === 1 && st.data.joined_7d === 1 && st.data.unsubscribed === 0, JSON.stringify(st.data));
check('list stats for an unknown list is 404', (await call('GET', '/v1/lists/99999/stats', { key: KP })).status === 404);
const rc = await call('GET', `/v1/lists/${pl.id}/contacts?limit=5`, { key: KP });
check('recent contacts endpoint lists newest first', rc.status === 200 && rc.data.data[0]?.email === 'reader@example.com' && rc.data.data[0].status === 'subscribed', JSON.stringify(rc.data));
const rc2 = await call('GET', `/v1/lists/${pl.id}/contacts?limit=5&offset=1`, { key: KP });
check('contacts endpoint pages with offset', rc2.status === 200 && rc2.data.data.length === 0, JSON.stringify(rc2.data));
check('create campaign needs a subject, html and one of your lists',
  (await call('POST', '/v1/campaigns', { key: KP, body: { html: 'x', list_id: pl.id } })).status === 400
  && (await call('POST', '/v1/campaigns', { key: KP, body: { subject: 's', list_id: pl.id } })).status === 400
  && (await call('POST', '/v1/campaigns', { key: KP, body: { subject: 's', html: 'x', list_id: 99999 } })).status === 400);
const made2 = await call('POST', '/v1/campaigns', { key: KP, body: { name: 'post:hello', subject: 'New post', html: '<p>Read it</p>', list_id: pl.id } });
check('campaign is created as a draft', made2.status === 201 && made2.data.status === 'draft' && made2.data.name === 'post:hello', JSON.stringify(made2.data));
check('send needs an existing campaign', (await call('POST', '/v1/campaigns/99999/send', { key: KP })).status === 404);
const sent2 = await call('POST', `/v1/campaigns/${made2.data.id}/send`, { key: KP });
check('draft is queued for the list', sent2.status === 200 && sent2.data.queued === 1, JSON.stringify(sent2.data));
check('a sent campaign cannot be sent twice', (await call('POST', `/v1/campaigns/${made2.data.id}/send`, { key: KP })).status === 400);
await new Promise((r) => setTimeout(r, 4500));
const done2 = await call('GET', `/v1/campaigns/${made2.data.id}`, { key: KP });
check('the API-sent campaign was delivered', done2.data.sent === 1, JSON.stringify(done2.data));

// daily cap
const K3 = (await call('POST', '/api/workspaces/1/api-keys', { token: A, body: { name: 'cap' } })).data.key;
await call('PUT', `/api/admin/workspaces/1`, { token: A, body: { daily_limit: 1 } });
const capped = await call('POST', '/v1/emails', { key: K3, body: { to: 'ada@example.com', subject: 's', html: 'x' } });
check('daily cap is enforced for API sends', capped.status === 429, String(capped.status));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
