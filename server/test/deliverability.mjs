// Signup hygiene, list health, the pre-send check, warm-up and the preference center, against a live server.
// Fresh empty database, FORCE_PROVIDER=console. Takes about 50 seconds because it waits for the sending queue.
const BASE = process.env.BASE || 'http://localhost:4000';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, { token, key, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
// Array values become repeated fields, the way a browser sends several ticked boxes.
const formPost = (path, fields) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) body.append(k, String(x));
  return fetch(BASE + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
};
const W1 = '/api/workspaces/1';

// setup
const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', W1, { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: '1 Main St, Abuja' } });
const made = await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'owner@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } });
const W2 = made.data.id;
const O = (await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'acme-pass-99' } })).data.token;
const mkList = async (name, token = A, ws = 1) => (await call('POST', `/api/workspaces/${ws}/lists`, { token, body: { name } })).data;
const weekly = await mkList('Weekly News'), beta = await mkList('Beta Tips'), proof = await mkList('Proofing');
const acmeList = await mkList('Acme list', O, W2);
const add = (email, first, list, extra = {}) => call('POST', `${W1}/contacts`, { token: A, body: { email, first_name: first, list_id: list.id, ...extra } });
const contactsOf = async () => (await call('GET', `${W1}/contacts`, { token: A })).data;
const idOf = async (email) => (await contactsOf()).find((c) => c.email === email)?.id;

/* ---------- signup hygiene ---------- */
const bad1 = await add('x@mailinator.com', 'X', proof);
check('a disposable address is refused when added by hand', bad1.status === 400 && bad1.data.code === 'disposable', JSON.stringify(bad1.data));
const bad2 = await add('ada@gmial.com', 'Ada', proof);
check('a typo is refused with the suggested fix', bad2.status === 400 && bad2.data.suggestion === 'ada@gmail.com' && bad2.data.error.includes('Did you mean'), JSON.stringify(bad2.data));
const bad3 = await add('a@nobody.invalid', 'A', proof);
check('an address that cannot receive mail is refused', bad3.status === 400 && bad3.data.code === 'no_mx', JSON.stringify(bad3.data));
check('shared addresses like info@ are allowed by default and marked', (await add('info@example.com', 'Info', proof)).status === 200 && (await contactsOf()).find((c) => c.email === 'info@example.com').role_address === true);
await call('PUT', W1, { token: A, body: { block_role: true } });
const roleBlocked = await add('support@example.com', 'S', proof);
check('shared addresses are refused once the workspace blocks them', roleBlocked.status === 400 && roleBlocked.data.code === 'role', JSON.stringify(roleBlocked.data));
await call('PUT', W1, { token: A, body: { block_role: false } });
check('a person with a personal address is never marked as shared', (await add('ada.lovelace@example.com', 'Ada', proof)).status === 200 && (await contactsOf()).find((c) => c.email === 'ada.lovelace@example.com').role_address === false);

const imp = await call('POST', `${W1}/contacts/import`, { token: A, body: { list_id: proof.id, csv: 'email,first_name\nok1@example.com,A\nbad@mailinator.com,B\ntypo@gmial.com,C\ndead@x.invalid,D\nok2@example.com,E' } });
check('an import keeps good rows and reports the rejected ones by reason', imp.status === 200 && imp.data.imported === 2 && imp.data.rejected === 3 && imp.data.rejected_by.disposable === 1 && imp.data.rejected_by.typo === 1 && imp.data.rejected_by.no_mx === 1, JSON.stringify(imp.data));
check('rejected import rows are never saved', !(await contactsOf()).some((c) => /mailinator|gmial|x\.invalid/.test(c.email)));

const key = (await call('POST', `${W1}/api-keys`, { token: A, body: { name: 'k' } })).data.key;
const apiBad = await call('POST', '/v1/contacts', { key, body: { email: 'z@yopmail.com', list: 'Proofing' } });
const apiTypo = await call('POST', '/v1/contacts', { key, body: { email: 'z@hotmial.com' } });
check('the API refuses disposable addresses with a code', apiBad.status === 400 && apiBad.data.code === 'disposable', JSON.stringify(apiBad.data));
check('the API suggests the fix for a typo', apiTypo.status === 400 && apiTypo.data.suggestion === 'z@hotmail.com', JSON.stringify(apiTypo.data));
check('the API still accepts a good address', (await call('POST', '/v1/contacts', { key, body: { email: 'good@example.com', list: 'Proofing' } })).status === 200);

const form = (await call('POST', `${W1}/forms`, { token: A, body: { name: 'Signup', title: 'Join', consent_text: 'I agree to receive the newsletter.', list_id: weekly.id, double_optin: false } })).data;
const t = (await (await fetch(`${BASE}/f/${form.slug}`)).text()).match(/name="t" value="([^"]+)"/)[1];
await sleep(2200);
const sub = async (email) => { const r = await fetch(`${BASE}/f/${form.slug}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email, consent: 'on', t }) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
const formTypo = await sub('visitor@gmial.com');
check('a public signup form tells the visitor about a typo', formTypo.status === 400 && formTypo.data.error === 'Did you mean visitor@gmail.com?', JSON.stringify(formTypo.data));
const formDisp = await sub('visitor@mailinator.com');
check('a public signup form refuses a disposable inbox', formDisp.status === 400 && /Disposable/.test(formDisp.data.error), JSON.stringify(formDisp.data));
check('a good signup still works', (await sub('visitor@example.com')).status === 200);
await sleep(600);
check('and the good signup is saved', (await contactsOf()).some((c) => c.email === 'visitor@example.com' && c.status === 'subscribed'));
check('typo and disposable signups were not saved', !(await contactsOf()).some((c) => /gmial|mailinator/.test(c.email)));

/* ---------- list health ---------- */
await call('PUT', W1, { token: A, body: { block_disposable: false } });
await add('junk1@mailinator.com', 'J1', proof); await add('junk2@guerrillamail.com', 'J2', proof);
await call('PUT', W1, { token: A, body: { block_disposable: true } });
const scan = await call('GET', `${W1}/hygiene`, { token: A });
check('the scan counts disposable and shared addresses with examples', scan.status === 200 && scan.data.counts.disposable === 2 && scan.data.counts.role >= 1 && scan.data.samples.disposable.includes('junk1@mailinator.com') && scan.data.total >= 8, JSON.stringify(scan.data));
check('a workspace owner of another workspace has their own scan', (await call('GET', `/api/workspaces/${W2}/hygiene`, { token: O })).data.counts.disposable === 0);
check('cleaning needs a choice', (await call('POST', `${W1}/hygiene/clean`, { token: A, body: { kinds: ['role'] } })).status === 400);
const clean = await call('POST', `${W1}/hygiene/clean`, { token: A, body: { kinds: ['disposable'] } });
check('cleaning blocks only the bad addresses', clean.status === 200 && clean.data.cleaned === 2);
const afterClean = await contactsOf();
check('cleaned addresses are marked blocked and shared addresses are untouched', afterClean.find((c) => c.email === 'junk1@mailinator.com').status === 'bounced' && afterClean.find((c) => c.email === 'info@example.com').status === 'subscribed');
const sup = (await call('GET', `${W1}/suppressions`, { token: A })).data;
check('they are on the blocked list with the reason invalid', sup.filter((s) => s.reason === 'invalid').length === 2);
await call('PUT', W1, { token: A, body: { block_disposable: false } });
await add('junk1@mailinator.com', 'J1', proof);
await call('PUT', W1, { token: A, body: { block_disposable: true } });
check('a cleaned address stays blocked if it is added again', (await contactsOf()).find((c) => c.email === 'junk1@mailinator.com').status === 'bounced');

/* ---------- check before sending ---------- */
const P = await mkList('Precheck list');
await add('pat@example.com', 'Pat', P); await add('nameless@example.com', '', P);
const run = (body, token = A, ws = 1) => call('POST', `/api/workspaces/${ws}/precheck`, { token, body });
const idsOf = (r) => r.data.items.map((i) => i.id);
check('the check needs a sign in', (await call('POST', `${W1}/precheck`, { body: {} })).status === 401);
const spam = await run({ subject: 'FREE MONEY!!! act now', html: '<p>CLICK HERE <a href="http://bit.ly/x">click here</a> <a href="https://evil.example">paypal.com</a></p>', list_id: P.id });
check('a spammy email is marked risky with reasons', spam.status === 200 && spam.data.verdict === 'risky' && spam.data.score < 70 && ['subject_spam', 'link_shortener', 'link_mismatch'].every((x) => idsOf(spam).includes(x)), JSON.stringify(spam.data).slice(0, 400));
check('problems are listed before the things that passed', spam.data.items[0].level === 'fail' && spam.data.items.at(-1).level !== 'fail');
const gap = await run({ subject: 'Hello', html: '<p>Hello {{first_name}}, here is your monthly news and everything else you wanted to know this month.</p>', list_id: P.id });
const gapItem = gap.data.items.find((i) => i.id === 'merge_gap_first_name');
check('the check warns when recipients are missing a merge field', !!gapItem && gapItem.title.startsWith('1 of 2') && gap.data.audience === 2, JSON.stringify(gapItem));
const gapOk = await run({ subject: 'Hello', html: '<p>Hello {{first_name|there}}, here is your monthly news and everything else you wanted to know this month.</p>', list_id: P.id });
check('a fallback silences that warning', !idsOf(gapOk).some((x) => x.startsWith('merge_gap')));
const deep = await run({ subject: 'Hello', html: '<p>Read <a href="http://127.0.0.1:4000/health">this page</a> for the details and everything else you need to know.</p>', list_id: P.id, deep: true });
check('the link check refuses to look at internal addresses', idsOf(deep).includes('links_dead') && deep.data.links_checked === 1, JSON.stringify(deep.data.items.filter((i) => i.id === 'links_dead')));
const empty = await run({ subject: 'x', html: '<p>hello there everyone and welcome</p>', list_id: (await mkList('Nobody')).id });
check('an audience with no one in it fails', idsOf(empty).includes('audience_empty') && empty.data.audience === 0);
const foreign = await run({ subject: 'x', html: '<p>hello there everyone and welcome</p>', list_id: P.id }, O, W2);
check('another workspace cannot see the size of your list', foreign.status === 200 && foreign.data.audience === null);
const noDeep = await run({ subject: 'Hi', html: '<p>Read <a href="https://example.com/a">this</a> and more words to make it longer for the check.</p>' });
check('links are only fetched when asked', noDeep.data.links_checked === null);

/* ---------- warm-up ---------- */
const WL = await mkList('Warm list');
for (const n of [1, 2, 3, 4, 5]) await add(`w${n}@example.com`, `W${n}`, WL);
const camp = async (name, list) => (await call('POST', `${W1}/campaigns`, { token: A, body: { name, subject: name, html: `<p>${name} body for the people on the list</p>`, list_id: list.id } })).data;
const messagesOf = async (id) => (await call('GET', `${W1}/campaigns/${id}/messages`, { token: A })).data;
const c1 = await camp('First send', WL);
await call('POST', `${W1}/campaigns/${c1.id}/send`, { token: A });
await sleep(8000);
const m1 = await messagesOf(c1.id);
check('without warm-up the whole list goes out', m1.length === 5 && m1.every((m) => m.status === 'sent'), m1.map((m) => m.status).join());
const tok = (rows, email) => rows.find((m) => m.email === email).token;
await fetch(`${BASE}/t/o/${tok(m1, 'w3@example.com')}.png`);

const ownerTry = await call('PUT', `/api/workspaces/${W2}`, { token: O, body: { warmup_enabled: true, warmup_start_volume: 5 } });
check('a client owner cannot start warm-up', ownerTry.status === 200 && ownerTry.data.warmup_enabled === false);
check('warm-up settings are checked', (await call('PUT', W1, { token: A, body: { warmup_growth: 9 } })).status === 400 && (await call('PUT', W1, { token: A, body: { warmup_start_volume: 0 } })).status === 400);
await call('PUT', W1, { token: A, body: { warmup_enabled: true, warmup_start_volume: 7, warmup_growth: 2 } });
const wu = (await call('GET', `${W1}/warmup`, { token: A })).data;
check('warm-up reports day one, the cap and the plan', wu.enabled === true && wu.day === 1 && wu.today_cap === 7 && wu.schedule[0].cap === 7 && wu.schedule[1].cap === 14 && wu.sent_today === 5, JSON.stringify(wu));
const c2 = await camp('Second send', WL);
await call('POST', `${W1}/campaigns/${c2.id}/send`, { token: A });
await sleep(7500);
const m2 = await messagesOf(c2.id);
const sent2 = m2.filter((m) => m.status === 'sent').map((m) => m.email);
check('the cap holds the campaign back', sent2.length === 2 && m2.filter((m) => m.status === 'queued').length === 3, m2.map((m) => `${m.email}:${m.status}`).join());
check('the most engaged contact goes first', sent2.includes('w3@example.com'), sent2.join());
check('the campaign stays in sending while people wait', (await call('GET', `${W1}/campaigns`, { token: A })).data.find((c) => c.id === c2.id).status === 'sending');
await call('PUT', W1, { token: A, body: { warmup_enabled: false } });
await sleep(7500);
check('turning warm-up off lets the rest go', (await messagesOf(c2.id)).every((m) => m.status === 'sent'));
check('the warm-up status shows it is off', (await call('GET', `${W1}/warmup`, { token: A })).data.enabled === false);

/* ---------- preference center ---------- */
await add('w1@example.com', 'W1', beta);                       // w1 is on Warm list and Beta Tips
await add('w1@example.com', 'W1', weekly); await add('w2@example.com', 'W2', weekly);
const w1 = await idOf('w1@example.com'), w2 = await idOf('w2@example.com'), w5 = await idOf('w5@example.com');
const prof = async (id) => (await call('GET', `${W1}/profile/${id}`, { token: A })).data;
const t1 = tok(m1, 'w1@example.com'), t2 = tok(m1, 'w2@example.com'), t5 = tok(m1, 'w5@example.com');

const page = await fetch(`${BASE}/t/u/${t1}`);
const html = await page.text();
check('the unsubscribe link opens a preference center', page.status === 200 && html.includes('Email preferences') && html.includes('Weekly News') && html.includes('Beta Tips') && html.includes('Unsubscribe from everything') && html.includes('At most 1 email a week'));
check('the address on the page is masked', html.includes('w**@example.com') && !html.includes('w1@example.com'));
check('opening the page changes nothing', (await prof(w1)).contact.status === 'subscribed' && (await prof(w1)).lists.length === 3);
check('the page has no scripts', !/<script/i.test(html));
check('a bad link shows the invalid page', (await (await fetch(`${BASE}/t/u/nonsense`)).text()).includes('Link not recognised') && (await formPost('/t/p/' + 'a'.repeat(32), { action: 'save' })).status === 400);

const shown = (await prof(w1)).lists.map((l) => l.id).join(',');
const save1 = await formPost(`/t/p/${t1}`, { action: 'save', shown, keep: String(weekly.id), freq: '1' });
check('saving preferences redirects back to the page', save1.status === 303 && save1.headers.get('location') === `/t/u/${t1}?done=saved`, save1.headers.get('location'));
let p1 = await prof(w1);
check('unticked lists are left and remembered', !p1.lists.some((l) => l.id === beta.id) && p1.left.some((l) => l.id === beta.id) && p1.lists.some((l) => l.id === weekly.id));
check('every shown list they left unticked is left, not only one', p1.left.some((l) => l.id === WL.id) && p1.left.some((l) => l.id === beta.id));
check('the weekly limit is saved', p1.contact.max_per_week === 1);
check('they stay subscribed overall', p1.contact.status === 'subscribed');
const html2 = await (await fetch(`${BASE}/t/u/${t1}?done=saved`)).text();
check('the page confirms the save and shows the list they left', html2.includes('Your preferences are saved.') && html2.includes('you left this list') && /value="1" checked/.test(html2));

const viaApi = await call('POST', '/v1/contacts', { key, body: { email: 'w1@example.com', list: 'Beta Tips' } });
check('the API does not add them back to a list they left', viaApi.status === 200 && !(await prof(w1)).lists.some((l) => l.id === beta.id));
await call('POST', `${W1}/contacts/import`, { token: A, body: { list_id: beta.id, csv: 'email\nw1@example.com' } });
check('an import does not add them back either', !(await prof(w1)).lists.some((l) => l.id === beta.id));
const manual = await call('POST', `${W1}/profile/${w1}/lists`, { token: A, body: { list_id: beta.id } });
check('adding by hand is refused and says so', manual.status === 200 && manual.data.blocked === 1 && !(await prof(w1)).lists.some((l) => l.id === beta.id), JSON.stringify(manual.data));

const foreignSave = await formPost(`/t/p/${t1}`, { action: 'save', keep: [weekly.id, acmeList.id], freq: '1' });
const acmeCount = (await call('GET', `/api/workspaces/${W2}/lists`, { token: O })).data.find((l) => l.id === acmeList.id).contact_count;
check('forged list ids from the form are ignored', foreignSave.status === 303 && acmeCount === 0);

const rejoin2 = await formPost(`/t/p/${t1}`, { action: 'save', keep: [weekly.id, beta.id], freq: '1' });
p1 = await prof(w1);
check('ticking a list again rejoins it on their own say-so', rejoin2.status === 303 && p1.lists.some((l) => l.id === beta.id) && !p1.left.some((l) => l.id === beta.id));

// pause and weekly limit are honoured by the sending queue
const pause = await formPost(`/t/p/${t1}`, { action: 'pause', days: '30' });
const paused = (await prof(w1)).contact.paused_until;
check('pausing sets an end date about 30 days away', pause.status === 303 && paused && Math.abs(new Date(paused) - Date.now() - 30 * 86400000) < 3600000, String(paused));
await formPost(`/t/p/${t2}`, { action: 'save', keep: String(weekly.id), freq: '1' });
const c3 = await camp('Third send', weekly);
await call('POST', `${W1}/campaigns/${c3.id}/send`, { token: A });
await sleep(8000);
const m3 = await messagesOf(c3.id);
const row = (e) => m3.find((m) => m.email === e);
check('a paused contact is skipped, with the reason on the report', row('w1@example.com').status === 'skipped' && /paused/.test(row('w1@example.com').error || ''), JSON.stringify(row('w1@example.com')));
check('a contact over their weekly limit is skipped', row('w2@example.com').status === 'skipped' && /per week/.test(row('w2@example.com').error || ''), JSON.stringify(row('w2@example.com')));
await formPost(`/t/p/${t1}`, { action: 'resume' });
check('resuming clears the pause', (await prof(w1)).contact.paused_until === null);
check('both are still subscribed', (await prof(w1)).contact.status === 'subscribed' && (await prof(w2)).contact.status === 'subscribed');

// unsubscribing from everything still works the old way
const oneClick = await fetch(`${BASE}/t/u/${t5}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
check('one-click unsubscribe still works', oneClick.status === 200 && (await prof(w5)).contact.status === 'unsubscribed');
check('someone already unsubscribed sees the simple page', !(await (await fetch(`${BASE}/t/u/${t5}`)).text()).includes('Email preferences'));
check('only subscribed people can change preferences', (await formPost(`/t/p/${t5}`, { action: 'pause', days: '30' })).status === 400);
await call('PUT', W1, { token: A, body: { preference_center: false } });
const simple = await (await fetch(`${BASE}/t/u/${t2}`)).text();
check('the owner can switch the preference center off', simple.includes('Confirm unsubscribe') && !simple.includes('Email preferences'));
await call('PUT', W1, { token: A, body: { preference_center: true } });
await call('PUT', `${W1}/lists/${beta.id}`, { token: A, body: { show_in_prefs: false } });
check('a list can be hidden from the preference page', !(await (await fetch(`${BASE}/t/u/${t2}`)).text()).includes('Beta Tips'));
check('list visibility needs a true or false', (await call('PUT', `${W1}/lists/${beta.id}`, { token: A, body: { show_in_prefs: 'yes' } })).status === 400);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
