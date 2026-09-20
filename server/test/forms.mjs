// Signup forms and double opt-in. Fresh database, FORCE_PROVIDER=console, RESEND_WEBHOOK_SECRET set, LOG=<server log>.
import crypto from 'crypto';
import fs from 'fs';

const BASE = process.env.BASE || 'http://localhost:4000';
const HOOK = process.env.RESEND_WEBHOOK_SECRET;
const LOG = process.env.LOG;
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { token, key, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const pageT = async (slug) => (await (await fetch(`${BASE}/f/${slug}`)).text()).match(/name="t" value="([^"]+)"/)[1];
const subscribe = async (slug, body, opts = {}) => {
  const res = await fetch(`${BASE}/f/${slug}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ consent: 'on', ...body }), ...opts });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const tokenFor = (email) => {
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(`[confirm email] ${email} |`));
  const m = lines.length && lines[lines.length - 1].match(/\/confirm\/([\w-]+)/);
  return m ? m[1] : null;
};
const hookSign = (payload) => {
  const raw = JSON.stringify(payload), id = 'msg_' + crypto.randomBytes(5).toString('hex'), ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', Buffer.from(HOOK.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
  return { raw, headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` } };
};

// setup
const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', '/api/workspaces/1', { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: 'Abuja' } });
const list = (await call('POST', '/api/workspaces/1/lists', { token: A, body: { name: 'Subscribers' } })).data;
const otherList = (await call('POST', '/api/workspaces/1/lists', { token: A, body: { name: 'Other' } })).data;
const made = await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'owner@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } });
const W2 = made.data.id;
const O = (await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'acme-pass-99' } })).data.token;
const list2 = (await call('POST', `/api/workspaces/${W2}/lists`, { token: O, body: { name: 'Acme list' } })).data;

const base = { name: 'Newsletter', title: 'Join <b>us</b>', description: 'Monthly news', consent_text: 'I agree to receive the monthly newsletter.', list_id: list.id };

// form validation
check('form needs a list', (await call('POST', '/api/workspaces/1/forms', { token: A, body: { ...base, list_id: undefined } })).status === 400);
check('form needs a real consent sentence', (await call('POST', '/api/workspaces/1/forms', { token: A, body: { ...base, consent_text: 'ok' } })).status === 400);
check('javascript: redirect is refused', (await call('POST', '/api/workspaces/1/forms', { token: A, body: { ...base, redirect_url: 'javascript:alert(1)' } })).status === 400);
check('a form cannot use another workspace list', (await call('POST', `/api/workspaces/${W2}/forms`, { token: O, body: { ...base, list_id: list.id } })).status === 400);
const f1 = (await call('POST', '/api/workspaces/1/forms', { token: A, body: { ...base, redirect_url: 'https://wyntek.ng/thanks' } })).data;
check('form is created with a slug and public link', !!f1.slug && f1.url === `${BASE}/f/${f1.slug}`, JSON.stringify(f1));

// hosted page
const pageRes = await fetch(`${BASE}/f/${f1.slug}`);
const html = await pageRes.text();
check('hosted form page loads', pageRes.status === 200 && html.includes('Monthly news'));
check('form text is escaped', html.includes('Join &lt;b&gt;us&lt;/b&gt;') && !html.includes('<b>us</b>'));
const csp = pageRes.headers.get('content-security-policy') || '';
check('form page may be embedded and has a script nonce', csp.includes('frame-ancestors *') && /script-src 'nonce-/.test(csp) && !pageRes.headers.get('x-frame-options'), csp);
check('embed mode renders', (await fetch(`${BASE}/f/${f1.slug}?embed=1`)).status === 200);
check('unknown form is 404', (await fetch(`${BASE}/f/nope-123`)).status === 404);
const pre = await fetch(`${BASE}/f/${f1.slug}/subscribe`, { method: 'OPTIONS', headers: { Origin: 'https://client.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
check('cross-site embeds are allowed to post (CORS)', pre.headers.get('access-control-allow-origin') === '*');

// second form (single opt-in) and the foreign workspace form, then one shared wait for the timing check
const f2 = (await call('POST', '/api/workspaces/1/forms', { token: A, body: { ...base, name: 'Quick', double_optin: false, list_id: otherList.id } })).data;
const f3 = (await call('POST', `/api/workspaces/${W2}/forms`, { token: O, body: { ...base, name: 'Acme form', list_id: list2.id } })).data;
const t1 = await pageT(f1.slug), t2 = await pageT(f2.slug), t3 = await pageT(f3.slug);
const tFresh = await pageT(f1.slug);
const signups = async (fid, token = A, ws = 1) => (await call('GET', `/api/workspaces/${ws}/forms/${fid}/signups`, { token })).data;
const contacts = async () => (await call('GET', '/api/workspaces/1/contacts', { token: A })).data;

// negative signups
check('bad email is refused', (await subscribe(f1.slug, { email: 'nope', t: t1 })).status === 400);
check('missing consent is refused', (await subscribe(f1.slug, { email: 'a@example.com', consent: '', t: t1 })).status === 400);
check('bots get a normal answer but nothing happens (honeypot)', (await subscribe(f1.slug, { email: 'bot1@example.com', website: 'http://spam', t: t1 })).status === 200);
check('submitting within two seconds asks a person to wait and retry', (await subscribe(f1.slug, { email: 'bot2@example.com', t: tFresh })).status === 400);
check('forged timing token gets a normal answer but nothing happens', (await subscribe(f1.slug, { email: 'bot3@example.com', t: '1.abc' })).status === 200);
await sleep(2300);
await sleep(600);
check('none of the bot attempts created a signup', (await signups(f1.id)).length === 0);

// double opt-in
const good = await subscribe(f1.slug, { email: 'Ada@Example.com', first_name: 'Ada', t: t1 });
check('valid signup returns the success message and redirect', good.status === 200 && good.data.message.includes('Check your inbox') && good.data.redirect === 'https://wyntek.ng/thanks', JSON.stringify(good));
await sleep(900);
const s1 = await signups(f1.id);
check('signup is pending and the confirmation email was sent', s1.length === 1 && s1[0].status === 'pending' && s1[0].email_status === 'sent', JSON.stringify(s1));
check('nobody is subscribed before confirming', !(await contacts()).some((c) => c.email === 'ada@example.com'));
const tok = tokenFor('ada@example.com');
check('the confirmation email has a link', !!tok);
const getConfirm = await fetch(`${BASE}/confirm/${tok}`);
const confirmHtml = await getConfirm.text();
check('opening the link only shows a button (scanner safe)', getConfirm.status === 200 && confirmHtml.includes('Confirm subscription') && !(await contacts()).some((c) => c.email === 'ada@example.com'));
check('confirm page cannot be framed', (getConfirm.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));
const post = await fetch(`${BASE}/confirm/${tok}`, { method: 'POST' });
check('confirming subscribes the person', post.status === 200 && (await post.text()).includes('You are subscribed'));
const ada = (await contacts()).find((c) => c.email === 'ada@example.com');
check('contact is subscribed with a full consent record', ada?.status === 'subscribed' && ada.consent_source === `form:${f1.slug}` && ada.consent_text === base.consent_text && !!ada.consent_ip && ada.first_name === 'Ada', JSON.stringify(ada));
const inList = (await call('GET', '/api/workspaces/1/lists', { token: A })).data.find((l) => l.id === list.id);
check('contact joined the form list', inList.subscribed_count === 1);
check('the link works only once', (await fetch(`${BASE}/confirm/${tok}`, { method: 'POST' })).status === 400);
check('garbage confirmation links are refused', (await fetch(`${BASE}/confirm/${'x'.repeat(43)}`)).status === 400);

// repeats and limits
await subscribe(f1.slug, { email: 'ada@example.com', t: t1 });
await sleep(500);
check('someone already on the list gets no second email or signup', (await signups(f1.id)).length === 1);
await subscribe(f1.slug, { email: 'ada@example.com', t: t1 });
check('repeated signups from one address are rate limited', (await subscribe(f1.slug, { email: 'ada@example.com', t: t1 })).status === 429);

// plain HTML post (custom forms without JavaScript)
const plain = await fetch(`${BASE}/f/${f1.slug}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'plain@example.com', consent: 'on' }) });
const plainHtml = await plain.text();
check('plain form posts get a thank you page with the continue link', plain.status === 200 && (plain.headers.get('content-type') || '').includes('text/html') && plainHtml.includes('Check your inbox') && plainHtml.includes('https://wyntek.ng/thanks'));

// single opt-in and re-subscribing
const key = (await call('POST', '/api/workspaces/1/api-keys', { token: A, body: { name: 'k' } })).data.key;
await call('POST', '/v1/contacts', { key, body: { email: 'bob@example.com', first_name: 'Bob' } });
await call('POST', '/v1/contacts/bob%40example.com/unsubscribe', { key });
await subscribe(f2.slug, { email: 'cy@example.com', t: t2 });
await subscribe(f2.slug, { email: 'bob@example.com', t: t2 });
await sleep(1200);
const cy = (await contacts()).find((c) => c.email === 'cy@example.com');
check('single opt-in subscribes immediately with consent recorded', cy?.status === 'subscribed' && cy.consent_source === `form:${f2.slug}`);
const s2 = await signups(f2.id);
check('single opt-in signups are logged as confirmed with no email', s2.find((s) => s.email === 'cy@example.com')?.status === 'confirmed' && s2.find((s) => s.email === 'cy@example.com')?.email_status === 'none');
check('an unsubscribed person still has to confirm, even on single opt-in',
  (await contacts()).find((c) => c.email === 'bob@example.com')?.status === 'unsubscribed' && s2.find((s) => s.email === 'bob@example.com')?.status === 'pending');
await fetch(`${BASE}/confirm/${tokenFor('bob@example.com')}`, { method: 'POST' });
check('confirming brings the unsubscribed person back', (await contacts()).find((c) => c.email === 'bob@example.com')?.status === 'subscribed');

// suppression
const sent = await call('POST', '/v1/emails', { key, body: { to: 'dee@example.com', subject: 's', html: 'x' } });
const evt = hookSign({ type: 'email.bounced', data: { email_id: sent.data.provider_id, bounce: { type: 'Permanent', message: 'gone' } } });
await fetch(`${BASE}/webhooks/resend`, { method: 'POST', headers: evt.headers, body: evt.raw });
await subscribe(f2.slug, { email: 'dee@example.com', t: t2 });
await sleep(700);
check('a bounced address cannot be signed up again', !(await contacts()).some((c) => c.email === 'dee@example.com' && c.status === 'subscribed') && !(await signups(f2.id)).some((s) => s.email === 'dee@example.com'));

// workspace without an approved sender
await subscribe(f3.slug, { email: 'zed@example.com', t: t3 });
await sleep(900);
const s3 = await signups(f3.id, O, W2);
check('a form without an approved sender records why the email failed', s3.length === 1 && s3[0].email_status === 'failed' && /Sender not approved/.test(s3[0].email_error || ''), JSON.stringify(s3));

// isolation
check('another workspace cannot read these forms', (await call('GET', '/api/workspaces/1/forms', { token: O })).status === 403);
check('another workspace cannot edit this form through its own path', (await call('PUT', `/api/workspaces/${W2}/forms/${f1.id}`, { token: O, body: { ...base, list_id: list2.id } })).status === 404);
check('another workspace cannot read its signups through its own path', (await signups(f1.id, O, W2)).length === 0);
check('form list only shows own forms with counts', (await call('GET', '/api/workspaces/1/forms', { token: A })).data.find((f) => f.id === f1.id).confirmed === 1);

// switching a form off and erasure
await call('PUT', `/api/workspaces/1/forms/${f2.id}`, { token: A, body: { ...base, list_id: otherList.id, double_optin: false, active: false } });
check('a form that is switched off disappears from the public web', (await fetch(`${BASE}/f/${f2.slug}`)).status === 404 && (await subscribe(f2.slug, { email: 'late@example.com', t: t2 })).status === 404);
const adaId = ada.id;
await call('DELETE', `/api/workspaces/1/contacts/${adaId}`, { token: A });
check('deleting a contact erases their signup records', !(await signups(f1.id)).some((s) => s.email === 'ada@example.com'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
