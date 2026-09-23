// Analytics. Fresh database, FORCE_PROVIDER=console, JWT_SECRET set (used to sign tracked links like the server does).
import crypto from 'crypto';

const BASE = process.env.BASE || 'http://localhost:4000';
const SECRET = process.env.JWT_SECRET;
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const sig = (token, url) => crypto.createHmac('sha256', SECRET).update(`c:${token}:${url}`).digest('hex').slice(0, 32);
const open = (token, ua) => fetch(`${BASE}/t/o/${token}.png`, { headers: { 'User-Agent': ua } });
const click = (token, url, ua) => fetch(`${BASE}/t/c/${token}?url=${encodeURIComponent(url)}&sig=${sig(token, url)}`, { redirect: 'manual', headers: { 'User-Agent': ua } });
const MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const GMAIL = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
const BOT = 'Mozilla/5.0 (compatible; SecurityScanner/1.0; +http://scan.example)';

const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', '/api/workspaces/1', { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: 'Abuja' } });
const list = (await call('POST', '/api/workspaces/1/lists', { token: A, body: { name: 'L' } })).data;
for (const e of ['a', 'b', 'c', 'd', 'e']) await call('POST', '/api/workspaces/1/contacts', { token: A, body: { email: `${e}@example.com`, first_name: e, list_id: list.id } });
const camp = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { name: 'Stats', subject: 'Hi', html: '<a href="https://wyntek.ng/a">A</a><a href="https://wyntek.ng/b">B</a>', list_id: list.id } })).data;
await call('POST', `/api/workspaces/1/campaigns/${camp.id}/send`, { token: A });
let rows = [];
for (let i = 0; i < 40 && rows.filter((m) => m.status === 'sent').length < 5; i += 1) { await sleep(400); rows = (await call('GET', `/api/workspaces/1/campaigns/${camp.id}/messages`, { token: A })).data; }
const tok = (e) => rows.find((m) => m.email === `${e}@example.com`).token;
const sentAt = Math.max(...rows.map((m) => new Date(m.sent_at).getTime()));

// opens from different places
await open(tok('a'), MOBILE); await open(tok('b'), DESKTOP); await open(tok('c'), GMAIL); await open(tok('d'), BOT);
// a click straight after sending is a scanner, not a person
const early = await click(tok('a'), 'https://wyntek.ng/a', MOBILE);
check('an early click still redirects the visitor', early.status === 302 && early.headers.get('location') === 'https://wyntek.ng/a');
let s = (await call('GET', `/api/workspaces/1/analytics/campaigns/${camp.id}`, { token: A })).data;
check('a click within five seconds of sending is not counted', s.summary.clicked === 0, JSON.stringify(s.summary));
await sleep(Math.max(0, sentAt + 5400 - Date.now()));
await click(tok('a'), 'https://wyntek.ng/a', MOBILE);
await click(tok('a'), 'https://wyntek.ng/b', MOBILE);
await click(tok('b'), 'https://wyntek.ng/a', DESKTOP);
await click(tok('c'), 'https://wyntek.ng/a', BOT);

s = (await call('GET', `/api/workspaces/1/analytics/campaigns/${camp.id}?tz=60`, { token: A })).data;
check('summary counts people, not events, and ignores robots', s.summary.sent === 5 && s.summary.opened === 3 && s.summary.clicked === 2, JSON.stringify(s.summary));
check('rates are worked out from sent', s.summary.open_rate === 60 && s.summary.click_rate === 40 && s.summary.click_to_open_rate === 66.7, JSON.stringify(s.summary));
check('links are ranked by how many people clicked', s.links[0].url === 'https://wyntek.ng/a' && s.links[0].people === 2 && s.links[1].url === 'https://wyntek.ng/b' && s.links[1].people === 1, JSON.stringify(s.links));
const dev = Object.fromEntries(s.devices.map((d) => [d.device, d.people]));
check('devices split phones from desktops and drop robots', dev.mobile === 1 && dev.desktop === 2 && !dev.bot, JSON.stringify(s.devices));
check('the timeline groups first opens and clicks by hour', s.series.length >= 1 && s.series.reduce((n, p) => n + p.opened, 0) === 3 && s.series.reduce((n, p) => n + p.clicked, 0) === 2, JSON.stringify(s.series));
const report = (await call('GET', `/api/workspaces/1/campaigns/${camp.id}/messages`, { token: A })).data;
check('robots and scanners leave no trace in the recipient report', report.find((m) => m.email === 'd@example.com').open_count === 0 && report.find((m) => m.email === 'c@example.com').click_count === 0);

// workspace overview
const ov = (await call('GET', '/api/workspaces/1/analytics/overview?days=7&tz=60', { token: A })).data;
check('overview totals match', ov.totals.sent === 5 && ov.totals.opened === 3 && ov.totals.clicked === 2 && ov.totals.open_rate === 60, JSON.stringify(ov.totals));
check('overview has one point per day, today last', ov.series.length === 7 && ov.series[6].sent === 5 && ov.series[6].opened === 3 && ov.series.slice(0, 6).every((d) => d.sent === 0), JSON.stringify(ov.series.slice(-2)));
check('the best-time grid covers a week by 24 hours and adds up', ov.opens_grid.length === 7 && ov.opens_grid.every((r) => r.length === 24) && ov.opens_grid.flat().reduce((a, b) => a + b, 0) === 3);
check('campaigns are compared', ov.campaigns.length === 1 && ov.campaigns[0].name === 'Stats' && ov.campaigns[0].open_rate === 60);
check('the period is clamped and defaults sensibly', (await call('GET', '/api/workspaces/1/analytics/overview?days=9999', { token: A })).data.series.length === 365 && (await call('GET', '/api/workspaces/1/analytics/overview?days=abc', { token: A })).data.series.length === 30 && (await call('GET', '/api/workspaces/1/analytics/overview?days=0', { token: A })).data.series.length === 1);
const shifted = (await call('GET', '/api/workspaces/1/analytics/overview?days=1&tz=-720', { token: A })).data;
check('an odd time zone offset still works', shifted.series.length === 1);

// isolation and safety
const made = await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'owner@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } });
const O = (await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'acme-pass-99' } })).data.token;
check('another workspace cannot read these analytics', (await call('GET', `/api/workspaces/${made.data.id}/analytics/campaigns/${camp.id}`, { token: O })).status === 404 && (await call('GET', `/api/workspaces/${made.data.id}/analytics/overview`, { token: O })).data.totals.sent === 0);
check('bad ids are rejected', (await call('GET', '/api/workspaces/1/analytics/campaigns/abc', { token: A })).status === 400);
check('analytics need a sign in', (await call('GET', '/api/workspaces/1/analytics/overview')).status === 401);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
