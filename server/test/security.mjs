// Run against a live server: BASE=http://localhost:4000 node test/security.mjs
// Server should run with a fresh empty database and FORCE_PROVIDER=console.
import { encrypt, decrypt } from '../src/config.js';

const BASE = process.env.BASE || 'http://localhost:4000';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

async function call(method, path, { token, body, raw } = {}) {
  const res = await fetch(BASE + path, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// crypto round trip
const secretText = 'sk_live_abc123';
const enc = encrypt(secretText);
check('provider key encrypts and round-trips', enc !== secretText && !enc.includes(secretText) && decrypt(enc) === secretText);

// signup gating
const admin = await call('POST', '/api/auth/register', { body: { email: 'Admin@Wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } });
check('first account registers', admin.status === 200 && admin.data.token);
const A = admin.data.token;
const second = await call('POST', '/api/auth/register', { body: { email: 'evil@x.com', password: 'password123' } });
check('open signup is closed after the first account', second.status === 403);
const weak = await call('POST', '/api/auth/login', { body: { email: 'admin@wyntek.ng', password: 'nope' } });
check('wrong password rejected', weak.status === 401);

// auth token attacks
const none = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' + Buffer.from(JSON.stringify({ uid: 1 })).toString('base64url') + '.';
check('alg none token rejected', (await call('GET', '/api/auth/me', { token: none })).status === 401);
check('no token rejected', (await call('GET', '/api/auth/me')).status === 401);

// admin creates client
const made = await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'owner@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } });
check('admin creates client workspace', made.status === 200 && made.data.id);
const W = made.data.id;
const client = await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'acme-pass-99' } });
const C = client.data.token;
check('client can log in', !!C);
check('non-admin blocked from admin API', (await call('GET', '/api/admin/workspaces', { token: C })).status === 403);
check('client cannot enter another workspace', (await call('GET', '/api/workspaces/1', { token: C })).status === 403);

// privilege and spoofing
const w0 = await call('GET', `/api/workspaces/${W}`, { token: C });
check('workspace response hides provider key field', !('provider_api_key' in w0.data));
const spoof = await call('PUT', `/api/workspaces/${W}`, { token: C, body: { from_email: 'ceo@wyntek.ng' } });
check('client cannot spoof a domain that is not approved', spoof.status === 400, JSON.stringify(spoof.data));
const limit = await call('PUT', `/api/workspaces/${W}`, { token: C, body: { daily_limit: 999999, rate_per_minute: 1000, sending_domain: 'wyntek.ng', provider: 'console' } });
check('client cannot raise limits, change provider or domain', limit.data.daily_limit === 1000 && limit.data.sending_domain === 'acme.ng' && limit.data.provider === 'resend', JSON.stringify(limit.data));
const okSettings = await call('PUT', `/api/workspaces/${W}`, { token: C, body: { from_email: 'news@acme.ng', footer_address: '1 Acme Road, Lagos', provider_api_key: 'sk_client_key', tracking_domain: 'http://localhost:4000' } });
check('client sets valid sender, footer and own key', okSettings.status === 200 && okSettings.data.has_provider_key === true && !JSON.stringify(okSettings.data).includes('sk_client_key'));
const nulled = await call('PUT', `/api/workspaces/${W}`, { token: C, body: { tracking_domain: null, reply_to: null, footer_address: '1 Acme Road, Lagos' } });
check('saving a null tracking domain does not store the text "null"', nulled.status === 200 && !String(nulled.data.tracking_domain || '').includes('null'), JSON.stringify(nulled.data));
const badTrack = await call('PUT', `/api/workspaces/${W}`, { token: C, body: { tracking_domain: 'evil.com/"><script>' } });
check('tracking domain injection rejected', badTrack.status === 400);

// tenant isolation
const adminList = await call('POST', '/api/workspaces/1/lists', { token: A, body: { name: 'Admin list' } });
const foreignCampaign = await call('POST', `/api/workspaces/${W}/campaigns`, { token: C, body: { subject: 'x', html: 'x', list_id: adminList.data.id } });
check('campaign cannot use another tenant list', foreignCampaign.status === 400);
const foreignContact = await call('POST', `/api/workspaces/${W}/contacts`, { token: C, body: { email: 'a@b.ng', list_id: adminList.data.id } });
check('contact cannot be added to another tenant list', foreignContact.status === 400);
check('bad id returns 400 not 500', (await call('DELETE', `/api/workspaces/${W}/lists/abc`, { token: C })).status === 400);

// content injection and merge safety
const list = await call('POST', `/api/workspaces/${W}/lists`, { token: C, body: { name: 'Main' } });
await call('POST', `/api/workspaces/${W}/contacts/import`, { token: C, body: { list_id: list.data.id, csv: 'email,first_name,company\nada@example.com,Ada,<img src=x onerror=alert(1)>' } });
const camp = await call('POST', `/api/workspaces/${W}/campaigns`, { token: C, body: { subject: 'Hi {{first_name}}', html: '<p>Hi {{first_name}} of {{company}} [{{constructor}}] <a href="https://wyntek.ng/?a=1&amp;b=2">go</a></p>', list_id: list.data.id } });
const prev = await call('GET', `/api/workspaces/${W}/campaigns/${camp.data.id}/preview`, { token: C });
check('merge values are HTML escaped', !prev.data.html.includes('<img src=x') && prev.data.html.includes('&lt;img src=x'));
check('prototype keys do not leak through merge fields', !prev.data.html.includes('function') && prev.data.html.includes('[]'));

const prev2 = await call('GET', `/api/workspaces/${W}/campaigns/${camp.data.id}/preview`, { token: C });
check('links fall back to the app URL when no tracking domain is set', prev2.data.html.includes(`${BASE}/t/c/`) && !prev2.data.html.includes('//null'), prev2.data.html.match(/href="[^"]+"/)?.[0]);

// signed click links
const href = prev.data.html.match(/href="(http[^"]*\/t\/c\/[^"]+)"/)[1].replace(/&amp;/g, '&');
const ok = await call('GET', href.replace(BASE, ''), { raw: true });
check('signed link redirects to the real target', ok.status === 302 && ok.headers.get('location') === 'https://wyntek.ng/?a=1&b=2', ok.headers.get('location'));
const tampered = await call('GET', href.replace(BASE, '').replace(/url=[^&]+/, 'url=' + encodeURIComponent('https://evil.example')), { raw: true });
check('tampered url is refused (no open redirect)', tampered.status === 400);
const unsigned = await call('GET', `/t/c/${'a'.repeat(32)}?url=${encodeURIComponent('https://evil.example')}`, { raw: true });
check('unsigned redirect is refused', unsigned.status === 400);

// double send race and unsubscribe flow
const race = await Promise.all([1, 2, 3].map(() => call('POST', `/api/workspaces/${W}/campaigns/${camp.data.id}/send`, { token: C })));
check('concurrent sends enqueue exactly once', race.filter((r) => r.status === 200).length === 1, race.map((r) => r.status).join(','));
await sleep(7000);
const msgs = await call('GET', `/api/workspaces/${W}/campaigns/${camp.data.id}/messages`, { token: C });
check('exactly one message delivered', msgs.data.length === 1 && msgs.data[0].status === 'sent', JSON.stringify(msgs.data));
const tok = msgs.data[0].token;
const getUnsub = await call('GET', `/t/u/${tok}`, { raw: true });
const stillSub = (await call('GET', `/api/workspaces/${W}/contacts`, { token: C })).data[0].status;
check('GET unsubscribe link does not unsubscribe (scanner safe)', getUnsub.status === 200 && stillSub === 'subscribed', stillSub);
await fetch(`${BASE}/t/u/${tok}`, { method: 'POST' });
const nowUnsub = (await call('GET', `/api/workspaces/${W}/contacts`, { token: C })).data[0].status;
check('POST unsubscribe works', nowUnsub === 'unsubscribed', nowUnsub);

// empty list is refused, campaign returns to draft
const emptyList = await call('POST', `/api/workspaces/${W}/lists`, { token: C, body: { name: 'Empty' } });
const emptyCamp = await call('POST', `/api/workspaces/${W}/campaigns`, { token: C, body: { subject: 'x', html: 'x', list_id: emptyList.data.id } });
const emptySend = await call('POST', `/api/workspaces/${W}/campaigns/${emptyCamp.data.id}/send`, { token: C });
const afterEmpty = (await call('GET', `/api/workspaces/${W}/campaigns`, { token: C })).data.find((c) => c.id === emptyCamp.data.id);
check('sending to an empty list is refused and stays draft', emptySend.status === 400 && afterEmpty.status === 'draft', `${emptySend.status} ${afterEmpty?.status}`);

// import cap
const big = 'email\n' + Array.from({ length: 5001 }, (_, i) => `u${i}@example.com`).join('\n');
check('oversized import is refused', (await call('POST', `/api/workspaces/${W}/contacts/import`, { token: C, body: { csv: big } })).status === 400);

// login throttling
let last = 0;
for (let i = 0; i < 10; i++) last = (await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'wrong' + i } })).status;
check('repeated failed logins get rate limited', last === 429, String(last));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
