// Segments, tags and contact profiles. Fresh database, FORCE_PROVIDER=console, JWT_SECRET set.
import crypto from 'crypto';

const BASE = process.env.BASE || 'http://localhost:4000';
const SECRET = process.env.JWT_SECRET;
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, { token, key, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const sig = (token, url) => crypto.createHmac('sha256', SECRET).update(`c:${token}:${url}`).digest('hex').slice(0, 32);
const UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120';

const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', '/api/workspaces/1', { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: 'Abuja' } });
const mkList = async (name) => (await call('POST', '/api/workspaces/1/lists', { token: A, body: { name } })).data;
const L1 = await mkList('One'), L2 = await mkList('Two');
const csv1 = 'email,first_name,last_name,tags,company,city\nada@acme.ng,Ada,Obi,"vip;NEW",Acme,\nbob@gmail.com,Bob,,lagos,Zenith Bank,\neve@acme.ng,Eve,,vip|lagos,,Abuja\n';
const csv2 = 'email,first_name\ncy@gmail.com,Cy\ndee@yahoo.com,\n';
const imp = await call('POST', '/api/workspaces/1/contacts/import', { token: A, body: { list_id: L1.id, csv: csv1 } });
await call('POST', '/api/workspaces/1/contacts/import', { token: A, body: { list_id: L2.id, csv: csv2 } });
check('import reads a tags column', imp.data.imported === 3);
const contacts = async (q = '') => (await call('GET', `/api/workspaces/1/contacts${q}`, { token: A })).data;
const byEmail = async (e) => (await contacts()).find((c) => c.email === e);
check('tags are cleaned, lower-cased and split on ; and |', JSON.stringify((await byEmail('ada@acme.ng')).tags) === '["vip","new"]' && JSON.stringify((await byEmail('eve@acme.ng')).tags) === '["vip","lagos"]');
await call('POST', '/v1/contacts/cy%40gmail.com/unsubscribe', { key: (await call('POST', '/api/workspaces/1/api-keys', { token: A, body: { name: 'k' } })).data.key });

const preview = async (match, ...rules) => (await call('POST', '/api/workspaces/1/segments/preview', { token: A, body: { definition: { match, rules } } }));
const emails = async (match, ...rules) => { const r = await preview(match, ...rules); return r.status === 200 ? r.data.sample.map((p) => p.email).sort().join() : `ERR ${r.status} ${r.data.error}`; };
const R = (field, op, value, key) => ({ field, op, value, key });

check('status rule', await emails('all', R('status', 'is', 'unsubscribed')) === 'cy@gmail.com');
check('email domain and contains rules', await emails('all', R('email', 'ends_with', '@acme.ng')) === 'ada@acme.ng,eve@acme.ng' && await emails('all', R('email', 'contains', 'gmail')) === 'bob@gmail.com,cy@gmail.com');
check('list membership rules', await emails('all', R('list', 'in', L2.id)) === 'cy@gmail.com,dee@yahoo.com' && await emails('all', R('list', 'not_in', L2.id)) === 'ada@acme.ng,bob@gmail.com,eve@acme.ng');
check('tag rules', await emails('all', R('tag', 'has', 'VIP')) === 'ada@acme.ng,eve@acme.ng' && await emails('all', R('tag', 'not_has', 'vip')) === 'bob@gmail.com,cy@gmail.com,dee@yahoo.com');
check('custom field contains and empty checks', await emails('all', { field: 'attr', key: 'company', op: 'contains', value: 'bank' }) === 'bob@gmail.com' && await emails('all', { field: 'attr', key: 'company', op: 'is_empty' }) === 'cy@gmail.com,dee@yahoo.com,eve@acme.ng' && await emails('all', { field: 'attr', key: 'city', op: 'not_empty' }) === 'eve@acme.ng');
check('name rules', await emails('all', R('first_name', 'is_empty')) === 'dee@yahoo.com' && await emails('all', R('last_name', 'not_empty')) === 'ada@acme.ng' && await emails('all', R('first_name', 'equals', 'ADA')) === 'ada@acme.ng');
check('created rules', (await preview('all', R('created', 'within_days', 1))).data.total === 5 && (await preview('all', R('created', 'before_days', 1))).data.total === 0);
check('any and all combine rules', await emails('any', R('tag', 'has', 'vip'), R('email', 'contains', 'yahoo')) === 'ada@acme.ng,dee@yahoo.com,eve@acme.ng' && await emails('all', R('email', 'ends_with', '@acme.ng'), R('tag', 'has', 'lagos')) === 'eve@acme.ng');
const counted = (await preview('all', R('list', 'in', L2.id))).data;
check('the live count separates everyone from who can be emailed', counted.total === 2 && counted.subscribed === 1);

// behaviour rules from a real send
const camp = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { name: 'First', subject: 'Hi', html: '<a href="https://wyntek.ng/x">x</a>', list_id: L1.id } })).data;
await call('POST', `/api/workspaces/1/campaigns/${camp.id}/send`, { token: A });
let rows = [];
for (let i = 0; i < 40 && rows.filter((m) => m.status === 'sent').length < 3; i += 1) { await sleep(400); rows = (await call('GET', `/api/workspaces/1/campaigns/${camp.id}/messages`, { token: A })).data; }
const tok = (e) => rows.find((m) => m.email === e).token;
await fetch(`${BASE}/t/o/${tok('ada@acme.ng')}.png`, { headers: { 'User-Agent': UA } });
await fetch(`${BASE}/t/o/${tok('bob@gmail.com')}.png`, { headers: { 'User-Agent': UA } });
await sleep(Math.max(0, Math.max(...rows.map((m) => new Date(m.sent_at).getTime())) + 5400 - Date.now()));
await fetch(`${BASE}/t/c/${tok('bob@gmail.com')}?url=${encodeURIComponent('https://wyntek.ng/x')}&sig=${sig(tok('bob@gmail.com'), 'https://wyntek.ng/x')}`, { redirect: 'manual', headers: { 'User-Agent': UA } });
check('opened in the last days', await emails('all', R('opened', 'in_last_days', 7)) === 'ada@acme.ng,bob@gmail.com');
check('never opened only counts people who were emailed', await emails('all', R('opened', 'never')) === 'eve@acme.ng');
check('not opened in the last days', await emails('all', R('opened', 'not_in_last_days', 7)) === 'eve@acme.ng');
check('clicked rules', await emails('all', R('clicked', 'in_last_days', 7)) === 'bob@gmail.com' && await emails('all', R('clicked', 'never')) === 'ada@acme.ng,eve@acme.ng');
check('campaign rules', await emails('all', R('campaign', 'received', camp.id)) === 'ada@acme.ng,bob@gmail.com,eve@acme.ng' && await emails('all', R('campaign', 'opened', camp.id)) === 'ada@acme.ng,bob@gmail.com' && await emails('all', R('campaign', 'not_opened', camp.id)) === 'eve@acme.ng' && await emails('all', R('campaign', 'clicked', camp.id)) === 'bob@gmail.com');

// safety
check('unknown fields and conditions are refused', (await preview('all', R('status; DROP TABLE contacts', 'is', 'x'))).status === 400 && (await preview('all', R('status', "is'; --", 'subscribed'))).status === 400 && (await preview('all', R('email', 'regex', 'x'))).status === 400);
check('quotes in values are just text', (await preview('all', R('email', 'contains', "'; DROP TABLE contacts; --"))).data.total === 0 && (await contacts()).length === 5);
check('wildcards in values are escaped', (await preview('all', R('email', 'contains', '%'))).data.total === 0 && (await preview('all', R('email', 'contains', '_'))).data.total === 0);
check('custom field names are restricted', (await preview('all', { field: 'attr', key: "x' OR '1'='1", op: 'not_empty' })).status === 400);
check('rule counts and values are validated', (await preview('all')).status === 400 && (await preview('all', ...Array(11).fill(R('status', 'is', 'subscribed')))).status === 400 && (await preview('all', R('status', 'is', 'weird'))).status === 400 && (await preview('all', R('created', 'within_days', 0))).status === 400 && (await preview('all', R('tag', 'has', '  '))).status === 400);

// ownership
const made = await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'owner@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } });
const W2 = made.data.id;
const O = (await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'acme-pass-99' } })).data.token;
const foreign = (await call('POST', `/api/workspaces/${W2}/lists`, { token: O, body: { name: 'Acme list' } })).data;
check('rules cannot point at another workspace list or campaign', (await preview('all', R('list', 'in', foreign.id))).status === 400 && (await call('POST', `/api/workspaces/${W2}/segments/preview`, { token: O, body: { definition: { match: 'all', rules: [R('campaign', 'opened', camp.id)] } } })).status === 400);

// CRUD and filters
const seg = (await call('POST', '/api/workspaces/1/segments', { token: A, body: { name: 'VIPs', definition: { match: 'all', rules: [R('tag', 'has', 'vip')] } } })).data;
check('a segment saves and lists with counts', (await call('GET', '/api/workspaces/1/segments', { token: A })).data.find((s) => s.id === seg.id)?.total === 2);
check('a segment needs a name', (await call('POST', '/api/workspaces/1/segments', { token: A, body: { name: '', definition: { match: 'all', rules: [R('tag', 'has', 'vip')] } } })).status === 400);
check('one segment returns its people', (await call('GET', `/api/workspaces/1/segments/${seg.id}`, { token: A })).data.sample.length === 2);
check('contacts can be filtered by a segment and by tag', (await contacts(`?segmentId=${seg.id}`)).map((c) => c.email).sort().join() === 'ada@acme.ng,eve@acme.ng' && (await contacts('?tag=LAGOS')).map((c) => c.email).sort().join() === 'bob@gmail.com,eve@acme.ng');
check('another workspace cannot see or use it', (await call('GET', `/api/workspaces/${W2}/segments/${seg.id}`, { token: O })).status === 404 && (await call('GET', `/api/workspaces/${W2}/contacts?segmentId=${seg.id}`, { token: O })).status === 404 && (await call('GET', `/api/workspaces/${W2}/segments`, { token: O })).data.length === 0);
await call('PUT', `/api/workspaces/1/segments/${seg.id}`, { token: A, body: { name: 'VIPs and Lagos', definition: { match: 'any', rules: [R('tag', 'has', 'vip'), R('tag', 'has', 'lagos')] } } });
check('a segment can be edited', (await call('GET', `/api/workspaces/1/segments/${seg.id}`, { token: A })).data.total === 3);

// sending to a segment
const c2 = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { name: 'To VIPs', subject: 'VIP', html: '<p>Hi</p>', segment_id: seg.id, list_id: L2.id } })).data;
check('a campaign can target a segment instead of a list', c2.segment_id === seg.id && c2.list_id === null, JSON.stringify(c2));
check('a campaign needs a list or a segment', (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { subject: 'x', html: 'x' } })).status === 400);
check('another workspace segment is refused', (await call('POST', `/api/workspaces/${W2}/campaigns`, { token: O, body: { subject: 'x', html: 'x', segment_id: seg.id } })).status === 400);
await call('POST', '/api/workspaces/1/contacts', { token: A, body: { email: 'new@example.com', first_name: 'New', list_id: L2.id } });
const newId = (await byEmail('new@example.com')).id;
await call('PUT', `/api/workspaces/1/profile/${newId}`, { token: A, body: { tags: ['VIP'] } });
await call('POST', `/api/workspaces/1/campaigns/${c2.id}/send`, { token: A });
await sleep(6000);
const sent2 = (await call('GET', `/api/workspaces/1/campaigns/${c2.id}/messages`, { token: A })).data.map((m) => m.email).sort().join();
check('the segment is worked out at send time and skips people who cannot be emailed', sent2 === 'ada@acme.ng,bob@gmail.com,eve@acme.ng,new@example.com', sent2);
const listing = (await call('GET', '/api/workspaces/1/campaigns', { token: A })).data.find((c) => c.id === c2.id);
check('the campaign list shows the segment name', listing.segment_name === 'VIPs and Lagos');
check('duplicating keeps the audience', (await call('POST', `/api/workspaces/1/campaigns/${c2.id}/duplicate`, { token: A })).data.segment_id === seg.id);
const c3 = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { subject: 'Switch', html: '<p>x</p>', segment_id: seg.id } })).data;
await call('PUT', `/api/workspaces/1/campaigns/${c3.id}`, { token: A, body: { list_id: L1.id, segment_id: null } });
check('a draft can switch from a segment to a list', (await call('GET', '/api/workspaces/1/campaigns', { token: A })).data.find((c) => c.id === c3.id).list_id === L1.id);
const c4 = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { subject: 'Orphan', html: '<p>x</p>', segment_id: seg.id } })).data;
await call('DELETE', `/api/workspaces/1/segments/${seg.id}`, { token: A });
check('deleting a segment leaves campaigns unsendable, not broken', (await call('POST', `/api/workspaces/1/campaigns/${c4.id}/send`, { token: A })).status === 400);

// profiles and tags
const adaId = (await byEmail('ada@acme.ng')).id;
const prof = (await call('GET', `/api/workspaces/1/profile/${adaId}`, { token: A })).data;
check('a profile shows details, lists, emails and stats', prof.contact.email === 'ada@acme.ng' && prof.lists[0].name === 'One' && prof.emails.some((e) => e.campaign_name === 'First' && e.opened_at) && prof.emails[0].campaign_name === 'To VIPs' && prof.stats.received === 2 && prof.stats.opened === 1 && prof.contact.consent_source === 'csv-import', JSON.stringify(prof).slice(0, 300));
const edited = (await call('PUT', `/api/workspaces/1/profile/${adaId}`, { token: A, body: { first_name: 'Adaeze', tags: ['VIP', ' vip ', 'Customer', '<b>x</b>'], attributes: { company: 'Acme Ltd', bad_key: 'x' } } })).data;
check('a profile can be edited, with tags cleaned', edited.first_name === 'Adaeze' && JSON.stringify(edited.tags) === '["vip","customer","bx/b"]' && edited.attributes.company === 'Acme Ltd', JSON.stringify(edited));
check('names keep their value when not sent', (await call('PUT', `/api/workspaces/1/profile/${adaId}`, { token: A, body: { tags: [] } })).data.first_name === 'Adaeze');
await call('POST', `/api/workspaces/1/profile/${adaId}/lists`, { token: A, body: { list_id: L2.id } });
check('lists can be added and removed on a profile', (await call('GET', `/api/workspaces/1/profile/${adaId}`, { token: A })).data.lists.length === 2);
await call('DELETE', `/api/workspaces/1/profile/${adaId}/lists/${L2.id}`, { token: A });
check('removing a list works', (await call('GET', `/api/workspaces/1/profile/${adaId}`, { token: A })).data.lists.length === 1);
check('a foreign list cannot be added', (await call('POST', `/api/workspaces/1/profile/${adaId}/lists`, { token: A, body: { list_id: foreign.id } })).status === 400);
check('another workspace cannot open, edit or change this profile', (await call('GET', `/api/workspaces/${W2}/profile/${adaId}`, { token: O })).status === 404 && (await call('PUT', `/api/workspaces/${W2}/profile/${adaId}`, { token: O, body: { first_name: 'Hacked' } })).status === 404 && (await byEmail('ada@acme.ng')).first_name === 'Adaeze');

// API tags
const key = (await call('POST', '/api/workspaces/1/api-keys', { token: A, body: { name: 'k2' } })).data.key;
await call('POST', '/v1/contacts', { key, body: { email: 'api@example.com', tags: ['Web', 'web', 'Promo'] } });
await call('POST', '/v1/contacts', { key, body: { email: 'api@example.com', tags: ['later'] } });
check('the API sets and merges tags', JSON.stringify((await byEmail('api@example.com')).tags.sort()) === '["later","promo","web"]');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
