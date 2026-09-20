// Bounces, test emails, passwords, reset and team. Run against a fresh database with:
// FORCE_PROVIDER=console RESEND_WEBHOOK_SECRET=whsec_... and LOG=<server log path> (used to read reset links).
import crypto from 'crypto';
import fs from 'fs';

const BASE = process.env.BASE || 'http://localhost:4000';
const HOOK = process.env.RESEND_WEBHOOK_SECRET;
const LOG = process.env.LOG;
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function signed(secret, payload, { ts = Math.floor(Date.now() / 1000), tamper = false } = {}) {
  const raw = JSON.stringify(payload);
  const id = 'msg_' + crypto.randomBytes(6).toString('hex');
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return { raw: tamper ? raw.replace('bounced', 'delivered') : raw, headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` } };
}
async function hook(path, secret, payload, opts) {
  const { raw, headers } = signed(secret, payload, opts);
  const res = await fetch(BASE + path, { method: 'POST', headers, body: raw });
  return res.status;
}
const event = (type, email_id, extra = {}) => ({ type, created_at: new Date().toISOString(), data: { email_id, ...extra } });
const linkFor = (email) => {
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(`[system email] ${email} `));
  const m = lines.length && lines[lines.length - 1].match(/reset\?token=([\w-]+)/);
  return m ? m[1] : null;
};

// setup
const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', '/api/workspaces/1', { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: 'Abuja' } });
const list = (await call('POST', '/api/workspaces/1/lists', { token: A, body: { name: 'L' } })).data;
for (const e of ['ada', 'bob', 'cy']) await call('POST', '/api/workspaces/1/contacts', { token: A, body: { email: `${e}@example.com`, first_name: e, list_id: list.id } });
const camp = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { subject: 'Hi', html: '<p>Hello</p>', list_id: list.id } })).data;
await call('POST', `/api/workspaces/1/campaigns/${camp.id}/send`, { token: A });
await sleep(6000);
const msgs = (await call('GET', `/api/workspaces/1/campaigns/${camp.id}/messages`, { token: A })).data;
const pid = (e) => msgs.find((m) => m.email === `${e}@example.com`).provider_id;
const status = async (e) => (await call('GET', '/api/workspaces/1/contacts', { token: A })).data.find((c) => c.email === `${e}@example.com`)?.status;

// webhook signatures
const bad = event('email.bounced', pid('bob'), { bounce: { type: 'Permanent', message: 'no such user' } });
check('unsigned webhook is rejected', (await fetch(BASE + '/webhooks/resend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bad) })).status === 401);
check('wrong secret is rejected', (await hook('/webhooks/resend', 'whsec_' + Buffer.from('wrongwrongwrongwrong').toString('base64'), bad)) === 401);
check('tampered body is rejected', (await hook('/webhooks/resend', HOOK, bad, { tamper: true })) === 401);
check('stale timestamp is rejected (replay)', (await hook('/webhooks/resend', HOOK, bad, { ts: Math.floor(Date.now() / 1000) - 3600 })) === 401);
check('nothing changed after rejected webhooks', (await status('bob')) === 'subscribed');

// events
check('delivered event is accepted', (await hook('/webhooks/resend', HOOK, event('email.delivered', pid('ada')))) === 200);
check('temporary bounce is recorded but does not suppress',
  (await hook('/webhooks/resend', HOOK, event('email.bounced', pid('bob'), { bounce: { type: 'Transient', message: 'mailbox full' } }))) === 200 && (await status('bob')) === 'subscribed');
check('permanent bounce suppresses the contact',
  (await hook('/webhooks/resend', HOOK, event('email.bounced', pid('bob'), { bounce: { type: 'Permanent', message: 'no such user' } }))) === 200 && (await status('bob')) === 'bounced');
check('spam complaint suppresses the contact',
  (await hook('/webhooks/resend', HOOK, event('email.complained', pid('cy')))) === 200 && (await status('cy')) === 'complained');
const report = (await call('GET', `/api/workspaces/1/campaigns/${camp.id}/messages`, { token: A })).data;
const rowOf = (e) => report.find((m) => m.email === `${e}@example.com`);
check('report shows delivered, bounced and complained', rowOf('ada').delivered_at && rowOf('bob').bounced_at && rowOf('bob').bounce_type === 'Permanent' && rowOf('cy').complained_at);
const list1 = (await call('GET', '/api/workspaces/1/campaigns', { token: A })).data.find((c) => c.id === camp.id);
check('campaign counts include bounces and complaints', list1.bounced === 1 && list1.complained === 1 && list1.delivered === 1 && list1.sent === 3, JSON.stringify(list1));

// suppression is respected
const camp2 = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { subject: 'Again', html: '<p>Again</p>', list_id: list.id } })).data;
await call('POST', `/api/workspaces/1/campaigns/${camp2.id}/send`, { token: A });
await sleep(4500);
const second = (await call('GET', `/api/workspaces/1/campaigns/${camp2.id}/messages`, { token: A })).data;
check('later campaigns skip bounced and complained contacts', second.length === 1 && second[0].email === 'ada@example.com', JSON.stringify(second.map((m) => m.email)));
const counts = (await call('GET', '/api/workspaces/1/lists', { token: A })).data.find((l) => l.id === list.id);
check('list counts separate everyone from who can actually receive', counts.contact_count === 3 && counts.subscribed_count === 1, JSON.stringify(counts));
await call('POST', '/api/workspaces/1/contacts/import', { token: A, body: { list_id: list.id, csv: 'email\nbob@example.com\ncy@example.com' } });
check('re-importing does not resubscribe them', (await status('bob')) === 'bounced' && (await status('cy')) === 'complained');
const K = (await call('POST', '/api/workspaces/1/api-keys', { token: A, body: { name: 'k' } })).data.key;
const api = async (method, path, body) => { const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${K}` }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
check('API email to a bounced address is blocked', (await api('POST', '/v1/emails', { to: 'bob@example.com', subject: 's', html: 'x' })).status === 422);
const dana = await api('POST', '/v1/emails', { to: 'dana@example.com', subject: 's', html: 'x' });
check('API email to a new address sends', dana.status === 200);
await hook('/webhooks/resend', HOOK, event('email.bounced', dana.data.provider_id, { bounce: { type: 'Permanent', message: 'gone' } }));
check('a bounced API address is blocked next time', (await api('POST', '/v1/emails', { to: 'dana@example.com', subject: 's', html: 'x' })).status === 422);
const created = await api('POST', '/v1/contacts', { email: 'dana@example.com', first_name: 'Dana' });
check('a suppressed address becomes a bounced contact, not a subscribed one', created.data.status === 'bounced', JSON.stringify(created.data));

// client workspace, per-workspace webhook secret
const made = await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'owner@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } });
const W2 = made.data.id;
let O = (await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'acme-pass-99' } })).data.token;
const secret2 = 'whsec_' + crypto.randomBytes(24).toString('base64');
await call('PUT', `/api/workspaces/${W2}`, { token: O, body: { from_email: 'news@acme.ng', footer_address: 'Lagos', webhook_secret: secret2 } });
const w2 = (await call('GET', `/api/workspaces/${W2}`, { token: O })).data;
check('webhook secret is never returned', w2.has_webhook_secret === true && !JSON.stringify(w2).includes(secret2));
check('workspace webhook accepts its own secret', (await hook(`/webhooks/resend/${W2}`, secret2, event('email.delivered', 'none'))) === 200);
check('workspace webhook rejects the shared secret', (await hook(`/webhooks/resend/${W2}`, HOOK, event('email.delivered', 'none'))) === 401);
check('workspace without a secret has no webhook', (await hook('/webhooks/resend/1', HOOK, event('email.delivered', 'none'))) === 404);
await hook(`/webhooks/resend/${W2}`, secret2, event('email.bounced', pid('ada'), { bounce: { type: 'Permanent', message: 'x' } }));
check('a workspace cannot affect another workspace messages', (await status('ada')) === 'subscribed');

// test email
const t1 = await call('POST', '/api/workspaces/1/test-email', { token: A, body: { subject: 'Hello {{first_name}}', html: '<p>Hi {{first_name}}</p>' } });
check('test email goes to the signed-in user by default', t1.status === 200 && t1.data.to === 'admin@wyntek.ng', JSON.stringify(t1));
check('test email cannot go to strangers', (await call('POST', '/api/workspaces/1/test-email', { token: A, body: { subject: 's', html: 'x', to: 'stranger@example.com' } })).status === 400);
check('test email needs content', (await call('POST', '/api/workspaces/1/test-email', { token: A, body: { subject: '', html: '' } })).status === 400);
check('test email is not listed as an API email', (await call('GET', '/api/workspaces/1/api-emails', { token: A })).data.every((m) => !m.subject.startsWith('[Test]')));
check('test email needs an approved sender', (await call('POST', `/api/workspaces/${W2}/test-email`, { token: O, body: { subject: 's', html: 'x' } })).status === 200);

// password change
const change = await call('POST', '/api/auth/password', { token: O, body: { current: 'wrong-password', next: 'brand-new-pass-1' } });
check('wrong current password is refused', change.status === 400);
check('weak new password is refused', (await call('POST', '/api/auth/password', { token: O, body: { current: 'acme-pass-99', next: 'short' } })).status === 400);
await sleep(1100);
const changed = await call('POST', '/api/auth/password', { token: O, body: { current: 'acme-pass-99', next: 'brand-new-pass-1' } });
check('password changes and returns a fresh token', changed.status === 200 && !!changed.data.token);
check('fresh token works', (await call('GET', '/api/auth/me', { token: changed.data.token })).status === 200);
check('the old session is signed out', (await call('GET', '/api/auth/me', { token: O })).status === 401);
check('old password no longer works', (await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'acme-pass-99' } })).status === 401);
O = changed.data.token;

// forgot and reset
const unknown = await call('POST', '/api/auth/forgot', { body: { email: 'nobody@nowhere.ng' } });
await sleep(400);
check('forgot answers the same for unknown emails and sends nothing', unknown.status === 200 && !fs.readFileSync(LOG, 'utf8').includes('nobody@nowhere.ng'));
const known = await call('POST', '/api/auth/forgot', { body: { email: 'owner@acme.ng' } });
await sleep(700);
check('forgot answers the same for real emails', known.status === 200 && known.data.message === unknown.data.message);
const token = linkFor('owner@acme.ng');
check('a reset link was emailed', !!token);
check('garbage token is refused', (await call('POST', '/api/auth/reset', { body: { token: 'x'.repeat(43), password: 'another-pass-22' } })).status === 400);
check('weak password on reset is refused', (await call('POST', '/api/auth/reset', { body: { token, password: 'short' } })).status === 400);
await sleep(1100);
check('reset link sets a new password', (await call('POST', '/api/auth/reset', { body: { token, password: 'another-pass-22' } })).status === 200);
check('reset link works only once', (await call('POST', '/api/auth/reset', { body: { token, password: 'third-pass-333' } })).status === 400);
check('reset signs out older sessions', (await call('GET', '/api/auth/me', { token: O })).status === 401);
O = (await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'another-pass-22' } })).data.token;
check('login works with the reset password', !!O);

// team
const invite = await call('POST', `/api/workspaces/${W2}/members`, { token: O, body: { email: 'Teammate@Acme.ng' } });
check('owner can invite a new person', invite.status === 200 && invite.data.invited === true && invite.data.emailed === true && invite.data.invite_link.includes('/reset?token='), JSON.stringify(invite.data));
const inviteToken = linkFor('teammate@acme.ng');
check('the invite email carries a set-password link', !!inviteToken);
check('invited person sets a password', (await call('POST', '/api/auth/reset', { body: { token: inviteToken, password: 'teammate-pass-1' } })).status === 200);
const M = (await call('POST', '/api/auth/login', { body: { email: 'teammate@acme.ng', password: 'teammate-pass-1' } })).data.token;
const meM = await call('GET', '/api/auth/me', { token: M });
check('teammate sees only the workspace they were added to', meM.data.workspaces.length === 1 && meM.data.workspaces[0].id === W2);
check('teammate can use the workspace', (await call('GET', `/api/workspaces/${W2}/lists`, { token: M })).status === 200);
check('teammate cannot see another workspace', (await call('GET', '/api/workspaces/1/lists', { token: M })).status === 403);
check('teammate cannot invite people', (await call('POST', `/api/workspaces/${W2}/members`, { token: M, body: { email: 'x@acme.ng' } })).status === 403);
const members = (await call('GET', `/api/workspaces/${W2}/members`, { token: O })).data;
check('member list shows roles and management rights', members.can_manage === true && members.data.some((m) => m.email === 'teammate@acme.ng' && m.role === 'member'));
const adminRow = members.data.find((m) => m.role === 'admin');
check('owner cannot remove the Wyntek admin', (await call('DELETE', `/api/workspaces/${W2}/members/${adminRow.user_id}`, { token: O })).status === 400);
const mate = members.data.find((m) => m.email === 'teammate@acme.ng');
check('teammate cannot remove people', (await call('DELETE', `/api/workspaces/${W2}/members/${mate.user_id}`, { token: M })).status === 403);
check('owner can remove a teammate', (await call('DELETE', `/api/workspaces/${W2}/members/${mate.user_id}`, { token: O })).status === 200);
check('removed teammate loses access at once', (await call('GET', `/api/workspaces/${W2}/lists`, { token: M })).status === 403);
check('cross-tenant member list is blocked', (await call('GET', '/api/workspaces/1/members', { token: O })).status === 403);
const existing = await call('POST', `/api/workspaces/${W2}/members`, { token: O, body: { email: 'admin@wyntek.ng' } });
check('adding an existing account attaches it without a new invite', existing.status === 200 && existing.data.invited === false);

// csv through the API
const csv = 'Email;First Name;Company\nzed@example.com;Zed;"Lagos, Nigeria"\nzed@example.com;Zed;dup\nbroken;X;Y\n';
const imp = await call('POST', `/api/workspaces/${W2}/contacts/import`, { token: O, body: { csv } });
check('import reports imported, duplicates and problems', imp.data.imported === 1 && imp.data.duplicates === 1 && imp.data.skipped === 1 && imp.data.errors[0].row === 4, JSON.stringify(imp.data));
const zed = (await call('GET', `/api/workspaces/${W2}/contacts`, { token: O })).data.find((c) => c.email === 'zed@example.com');
check('quoted comma survived the import', zed?.attributes?.company === 'Lagos, Nigeria', JSON.stringify(zed));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
