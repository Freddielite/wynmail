// Unblock, exports, duplicate, preview text and name fallbacks. Fresh database, FORCE_PROVIDER=console,
// RESEND_WEBHOOK_SECRET set, LOG=<server log>.
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
const csv = async (path, token) => { const res = await fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); return { status: res.status, type: res.headers.get('content-type') || '', disp: res.headers.get('content-disposition') || '', text: await res.text() }; };
const bounce = async (id, type = 'Permanent') => hook({ type: 'email.bounced', data: { email_id: id, bounce: { type, message: 'gone' } } });
const complain = (id) => hook({ type: 'email.complained', data: { email_id: id } });
async function hook(payload) {
  const raw = JSON.stringify(payload), id = 'msg_' + crypto.randomBytes(5).toString('hex'), ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', Buffer.from(HOOK.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
  return (await fetch(`${BASE}/webhooks/resend`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` }, body: raw })).status;
}
const linkFor = (email) => { const l = fs.readFileSync(LOG, 'utf8').split('\n').filter((x) => x.includes(`[system email] ${email} `)); const m = l.length && l[l.length - 1].match(/reset\?token=([\w-]+)/); return m ? m[1] : null; };

// setup
const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', '/api/workspaces/1', { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: 'Abuja' } });
const list = (await call('POST', '/api/workspaces/1/lists', { token: A, body: { name: 'L' } })).data;
const add = (email, first, extra = {}) => call('POST', '/api/workspaces/1/contacts', { token: A, body: { email, first_name: first, list_id: list.id, ...extra } });
await add('ada@example.com', 'Ada'); await add('bob@example.com', 'Bob');
await add('formula@example.com', '=HYPERLINK(x)');
await call('POST', '/api/workspaces/1/contacts/import', { token: A, body: { list_id: list.id, csv: 'email,first_name,company\nzed@example.com,Zed,"Lagos, NG"' } });
const camp = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { name: 'First', subject: 'Hi', html: '<p>Hello</p>', list_id: list.id, preview_text: 'Preview me' } })).data;
await call('POST', `/api/workspaces/1/campaigns/${camp.id}/send`, { token: A });
await sleep(7000);
const rows = (await call('GET', `/api/workspaces/1/campaigns/${camp.id}/messages`, { token: A })).data;
const pid = (e) => rows.find((m) => m.email === `${e}@example.com`).provider_id;
await bounce(pid('ada')); await complain(pid('bob'));
const key = (await call('POST', '/api/workspaces/1/api-keys', { token: A, body: { name: 'k' } })).data.key;
const carl = await call('POST', '/v1/emails', { key, body: { to: 'carl@example.com', subject: 's', html: 'x' } });
await bounce(carl.data.provider_id);
const contacts = async (q = '') => (await call('GET', `/api/workspaces/1/contacts${q}`, { token: A })).data;
const status = async (e) => (await contacts()).find((c) => c.email === `${e}@example.com`)?.status;

// filters and blocked list
check('contacts can be filtered by status', (await contacts('?status=bounced')).map((c) => c.email).join() === 'ada@example.com' && (await contacts('?status=complained')).map((c) => c.email).join() === 'bob@example.com');
check('an unknown status filter is ignored', (await contacts('?status=nonsense')).length === 4);
const supp = (await call('GET', '/api/workspaces/1/suppressions', { token: A })).data;
const sOf = (e) => supp.find((s) => s.email === `${e}@example.com`);
check('blocked list shows every blocked address with its reason', sOf('ada')?.reason === 'bounced' && sOf('bob')?.reason === 'complained' && sOf('carl')?.reason === 'bounced', JSON.stringify(supp));
check('addresses with no contact are listed too', sOf('carl').contact_id === null && sOf('ada').contact_id !== null);

// unblock
const adaId = (await contacts()).find((c) => c.email === 'ada@example.com').id;
check('the owner can unblock a bounced contact', (await call('POST', `/api/workspaces/1/contacts/${adaId}/unblock`, { token: A, body: {} })).status === 200 && (await status('ada')) === 'subscribed');
check('unblocking also clears the blocked list', !(await call('GET', '/api/workspaces/1/suppressions', { token: A })).data.some((s) => s.email === 'ada@example.com'));
const bobId = (await contacts()).find((c) => c.email === 'bob@example.com').id;
check('someone who reported spam needs an explicit confirmation', (await call('POST', `/api/workspaces/1/contacts/${bobId}/unblock`, { token: A, body: {} })).status === 400 && (await status('bob')) === 'complained');
check('with the confirmation they can be unblocked', (await call('POST', `/api/workspaces/1/contacts/${bobId}/unblock`, { token: A, body: { confirm: true } })).status === 200 && (await status('bob')) === 'subscribed');
check('a contact that is not blocked cannot be unblocked', (await call('POST', `/api/workspaces/1/contacts/${adaId}/unblock`, { token: A, body: {} })).status === 400);
check('an address with no contact can be unblocked from the list', (await call('POST', `/api/workspaces/1/suppressions/${sOf('carl').id}/unblock`, { token: A, body: {} })).status === 200
  && (await call('POST', '/v1/emails', { key, body: { to: 'carl@example.com', subject: 's', html: 'x' } })).status === 200);
const camp2 = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { subject: 'Again', html: '<p>Again</p>', list_id: list.id } })).data;
await call('POST', `/api/workspaces/1/campaigns/${camp2.id}/send`, { token: A });
await sleep(6500);
check('unblocked people receive later campaigns again', (await call('GET', `/api/workspaces/1/campaigns/${camp2.id}/messages`, { token: A })).data.some((m) => m.email === 'ada@example.com'));

// permissions: a teammate and another workspace
const made = await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'owner@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } });
const W2 = made.data.id;
const O = (await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'acme-pass-99' } })).data.token;
await call('POST', `/api/workspaces/${W2}/members`, { token: O, body: { email: 'mate@acme.ng' } });
await call('POST', '/api/auth/reset', { body: { token: linkFor('mate@acme.ng'), password: 'mate-pass-123' } });
const M = (await call('POST', '/api/auth/login', { body: { email: 'mate@acme.ng', password: 'mate-pass-123' } })).data.token;
const w2list = (await call('POST', `/api/workspaces/${W2}/lists`, { token: O, body: { name: 'A' } })).data;
await call('POST', `/api/workspaces/${W2}/contacts`, { token: O, body: { email: 'q@example.com', list_id: w2list.id } });
const w2c = (await call('GET', `/api/workspaces/${W2}/contacts`, { token: O })).data[0];
check('a teammate cannot unblock addresses', (await call('POST', `/api/workspaces/${W2}/contacts/${w2c.id}/unblock`, { token: M, body: {} })).status === 403);
check('another workspace cannot unblock these addresses', (await call('POST', `/api/workspaces/${W2}/suppressions/${sOf('bob').id}/unblock`, { token: O, body: { confirm: true } })).status === 404 && (await call('GET', `/api/workspaces/${W2}/suppressions`, { token: O })).data.length === 0);

// duplicate
const dup = await call('POST', `/api/workspaces/1/campaigns/${camp.id}/duplicate`, { token: A });
check('duplicating makes a draft copy with the same content', dup.status === 200 && dup.data.status === 'draft' && dup.data.name === 'Copy of First' && dup.data.subject === 'Hi' && dup.data.html === '<p>Hello</p>' && dup.data.list_id === list.id && dup.data.preview_text === 'Preview me', JSON.stringify(dup.data));
check('the original is untouched', (await call('GET', '/api/workspaces/1/campaigns', { token: A })).data.find((c) => c.id === camp.id).status === 'sent');
check('another workspace cannot duplicate it', (await call('POST', `/api/workspaces/${W2}/campaigns/${camp.id}/duplicate`, { token: O })).status === 404);

// preview text and fallbacks
await call('POST', '/api/workspaces/1/contacts', { token: A, body: { email: 'noname@example.com', list_id: list.id } });
const noname = (await contacts()).find((c) => c.email === 'noname@example.com');
const fb = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { subject: 'Hi {{first_name|friend}}', html: '<p>Hello {{first_name|there}} from {{company|<us>}}</p>', list_id: list.id, preview_text: 'Big <news> for {{first_name|you}}' } })).data;
const p1 = (await call('GET', `/api/workspaces/1/campaigns/${fb.id}/preview?contact_id=${noname.id}`, { token: A })).data;
check('fallbacks fill in when a name is missing', p1.subject === 'Hi friend' && p1.html.includes('Hello there from &lt;us&gt;'), JSON.stringify(p1).slice(0, 300));
check('the preview text is hidden, escaped and merged', p1.html.includes('display:none') && p1.html.includes('Big &lt;news&gt; for you'));
const adaContact = (await contacts()).find((c) => c.email === 'ada@example.com');
const p2 = (await call('GET', `/api/workspaces/1/campaigns/${fb.id}/preview?contact_id=${adaContact.id}`, { token: A })).data;
check('real names win over fallbacks', p2.subject === 'Hi Ada' && p2.html.includes('Hello Ada'));
const long = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { subject: 's', html: 'x', list_id: list.id, preview_text: 'x'.repeat(400) } })).data;
check('preview text is limited to 150 characters', long.preview_text.length === 150);
const mail = await call('POST', '/v1/emails', { key, body: { to: 'x@example.com', subject: 'Hello {{name|friend}}', html: 'x' } });
check('fallbacks work in API emails too', mail.status === 200 && fs.readFileSync(LOG, 'utf8').includes('-> x@example.com :: Hello friend'));
const auto = await call('POST', '/api/workspaces/1/automations', { token: A, body: { name: 'A', list_id: list.id, active: false, steps: [{ delay_minutes: 0, subject: 'S', html: '<p>x</p>', preview_text: 'Step preview' }] } });
check('automation emails keep their preview text', (await call('GET', `/api/workspaces/1/automations/${auto.data.id}`, { token: A })).data.steps[0].preview_text === 'Step preview');

// exports
const ex = await csv('/api/workspaces/1/contacts/export', A);
const lines = ex.text.replace(/^\uFEFF/, '').trim().split('\r\n');
check('contacts export is a downloadable CSV with the right columns', ex.status === 200 && ex.type.includes('text/csv') && ex.disp.includes('attachment') && lines[0].startsWith('email,first_name,last_name,status,lists,consent_source') && lines[0].includes('company'), lines[0]);
check('every contact is in the export with its lists', lines.length - 1 === (await contacts()).length && ex.text.includes('ada@example.com,Ada,,subscribed,L'));
check('quoted commas survive the export', ex.text.includes('"Lagos, NG"'));
check('cells that look like formulas are neutralised', ex.text.includes("'=HYPERLINK(x)") && !ex.text.includes(',=HYPERLINK'));
check('exports need a sign in', (await csv('/api/workspaces/1/contacts/export')).status === 401);
check('another workspace only exports its own contacts', !(await csv(`/api/workspaces/${W2}/contacts/export`, O)).text.includes('ada@example.com') && (await csv(`/api/workspaces/${W2}/contacts/export`, O)).text.includes('q@example.com'));
const rep = await csv(`/api/workspaces/1/campaigns/${camp.id}/export`, A);
const repLines = rep.text.replace(/^\uFEFF/, '').trim().split('\r\n');
check('campaign report exports every recipient with outcomes', rep.status === 200 && repLines[0].startsWith('email,status,sent_at,delivered_at,opened_at') && repLines.length - 1 === rows.length && /ada@example\.com,sent,.*Permanent/.test(rep.text), repLines[0]);
check('another workspace cannot export this report', (await csv(`/api/workspaces/${W2}/campaigns/${camp.id}/export`, O)).status === 404);

// domain check endpoint
const dc = await call('GET', '/api/workspaces/1/domain-check', { token: A });
check('domain check returns the checks for the sending domain', dc.status === 200 && dc.data.domain === 'wyntek.ng' && dc.data.checks.length >= 4 && dc.data.checks.every((c) => ['ok', 'warn', 'missing', 'unknown'].includes(c.status)), JSON.stringify(dc.data).slice(0, 300));
check('domain check needs an approved domain', (await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'NoDomain', owner_email: 'nd@acme.ng', password: 'nodomain-pass-1' } })).status === 200
  && (await call('GET', `/api/workspaces/${(await call('GET', '/api/admin/workspaces', { token: A })).data.find((w) => w.name === 'NoDomain').id}/domain-check`, { token: A })).status === 400);

await call('PUT', '/api/workspaces/1', { token: A, body: { sending_domain: 'resend.dev', from_email: 'onboarding@resend.dev' } });
const shared = await call('GET', '/api/workspaces/1/domain-check', { token: A });
check('the shared test domain gets a friendly note instead of failing checks', shared.status === 200 && shared.data.checks.length === 0 && /shared Resend test domain/.test(shared.data.note || ''), JSON.stringify(shared.data));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
