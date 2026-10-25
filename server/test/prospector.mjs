// The email finder and its job runner, in-process on a scratch database. No network: pages come from a fake site map.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import zlib from 'zlib';
process.env.USE_PGLITE = '1';
process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'finder-'));
process.env.FORCE_PROVIDER = 'console';
const { migrate, query, one, many } = await import('../src/db.js');
const F = await import('../src/finder.js');
const P = await import('../src/prospector.js');
const { fetchPage } = await import('../src/safefetch.js');
const { attachLists } = await import('../src/contacts.js');
const D = await import('../src/discover.js');
const { merge } = await import('../src/render.js');
await migrate();

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

/* ---------- addresses ---------- */
const html = `<html><body><a href="mailto:Sales@Acme.ng?subject=Hi">Sales</a> info&#64;acme.ng, ops [at] acme [dot] ng,
  <a class="__cf_email__" data-cfemail="${(() => { const key = 0x42, s = 'cfo@acme.ng'; return key.toString(16).padStart(2, '0') + [...s].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join(''); })()}">[email&#160;protected]</a>
  noreply@acme.ng logo@2x.png abuse@acme.ng you@example.com a3f9c2e1b4d5a6f7e8d9c0b1a2f3e4d5@sentry.io <script>var e="hidden@acme.ng"</script></body></html>`;
const got = F.extractEmails(html);
check('finds mailto, plain, entity, [at] [dot] and Cloudflare-hidden addresses', ['sales@acme.ng', 'info@acme.ng', 'ops@acme.ng', 'cfo@acme.ng'].every((e) => got.includes(e)), got.join());
check('drops noreply, abuse, placeholders, image names, hashes and script text', !got.some((e) => /noreply|abuse|example|2x|sentry|hidden/.test(e)), got.join());
check('freemail and EU judged by the address', F.isFreemail('gmail.com') && F.isFreemail('yahoo.co.uk') && F.isFreemail('hotmail.fr') && !F.isFreemail('acme.ng') && F.isEuDomain('shop.de') && F.isEuDomain('x.eu') && !F.isEuDomain('acme.ng') && !F.isEuDomain('shop.co.uk'));
check('company domain is worked out', F.registrableDomain('www.shop.acme.com.ng') === 'acme.com.ng' && F.registrableDomain('blog.acme.io') === 'acme.io' && F.registrableDomain('acme.ng') === 'acme.ng');
check('sites are normalised and bad ones refused', F.normalizeSite('Acme.ng/contact')?.origin === 'https://acme.ng' && !F.normalizeSite('localhost') && !F.normalizeSite('http://127.0.0.1') && !F.normalizeSite('10.0.0.5') && !F.normalizeSite('nonsense') && !F.normalizeSite('http://user:pw@acme.ng') && !F.normalizeSite('https://acme.ng:8080') && !F.normalizeSite('file:///etc/passwd'));

/* ---------- robots.txt ---------- */
const rb = F.parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*.pdf$\nCrawl-delay: 4\n\nUser-agent: WynmailFinder\nDisallow: /contact');
check('a group naming us wins over *', !F.robotsAllows(rb, '/contact') && F.robotsAllows(rb, '/private') && rb.delay === null);
const rb2 = F.parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*.pdf$\nCrawl-delay: 4');
check('longest rule wins, wildcards and $ work, crawl-delay is read', !F.robotsAllows(rb2, '/private/x') && F.robotsAllows(rb2, '/private/open/x') && !F.robotsAllows(rb2, '/a/b.pdf') && F.robotsAllows(rb2, '/a/b.pdf?x') && F.robotsAllows(rb2, '/contact') && rb2.delay === 4);
check('Disallow: / blocks everything, empty Disallow allows', !F.robotsAllows(F.parseRobots('User-agent: *\nDisallow: /'), '/') && F.robotsAllows(F.parseRobots('User-agent: *\nDisallow:'), '/x'));

/* ---------- a fake internet ---------- */
const page = (body, links = '') => `<html><body><nav>${links}</nav>${body}</body></html>`;
const SITES = {
  'https://acme.ng/robots.txt': { status: 200, type: 'text/plain', body: 'User-agent: *\nDisallow: /admin' },
  'https://acme.ng/': { body: page('<footer>Write to hello@acme.ng</footer>', '<a href="/contact">Contact</a><a href="/about-us">About</a><a href="/blog/post-1">Blog</a><a href="/admin/contact">x</a><a href="https://other.com/contact">Other</a><a href="/logo.png">img</a>') },
  'https://acme.ng/contact': { body: page('<a href="mailto:sales@acme.ng">Sales</a> Owner: boss@gmail.com. Built by <a href="mailto:hi@webagency.io">Web Agency</a>. support@acme.ng') },
  'https://acme.ng/about-us': { body: page('Our team. noreply@acme.ng. hello@acme.ng') },
  'https://blocked.ng/robots.txt': { status: 200, type: 'text/plain', body: 'User-agent: *\nDisallow: /' },
  'https://blocked.ng/': { body: page('secret@blocked.ng') },
  'https://slow.ng/robots.txt': { status: 200, type: 'text/plain', body: 'User-agent: *\nCrawl-delay: 6\nDisallow: /contact' },
  'https://slow.ng/': { body: page('team@slow.ng', '<a href="/contact">Contact</a><a href="/about">About</a>') },
  'https://slow.ng/contact': { body: page('nope@slow.ng') },
  'https://slow.ng/about': { body: page('about@slow.ng') },
  'https://shop.de/robots.txt': { status: 404 },
  'https://shop.de/': { body: page('info@shop.de') },
  'https://dup.ng/robots.txt': { status: 404 },
  'https://dup.ng/': { body: page('known@dup.ng gone@dup.ng new@dup.ng fresh@mailinator.com') },
  'https://bad500.ng/robots.txt': { status: 503 },
  'https://nopage.ng/robots.txt': { status: 404 },
  'https://nopage.ng/': { status: 404 },
  'https://empty.ng/robots.txt': { status: 404 },
  'https://empty.ng/': { body: page('Nothing printed here.') },
  'https://pair.ng/robots.txt': { status: 404 },
  'https://pair.ng/': { body: `<html><head><title>Home | Pair Ltd</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Pair Ventures Ltd","email":"mailto:owner@pair.ng","telephone":"+234 803 000 1111"}</script></head><body><a href="tel:+2348030001111">Call</a><a href="mailto:ada.obi@pair.ng">Ada</a> info@pair.ng sales@pair.ng ben.eze@pair.ng</body></html>` },
  'https://hidden.ng/robots.txt': { status: 404 },
  'https://hidden.ng/': { body: page('Welcome to Hidden.') },
  'https://hidden.ng/sitemap.xml': { status: 200, type: 'application/xml', body: '<urlset><url><loc>https://hidden.ng/reach-us</loc></url><url><loc>https://hidden.ng/shop/item-1</loc></url></urlset>' },
  'https://hidden.ng/reach-us': { body: page('Talk to us: lead@hidden.ng') },
  'https://www.redir.ng/robots.txt': { status: 404 },
  'https://www.redir.ng/': { body: page('Reach us: sales@redir.ng') }
};
const asked = [];
const fake = async (url, o = {}) => {
  asked.push({ url, ua: o.userAgent });
  if (url.startsWith('https://redir.ng/robots.txt')) return { status: 200, type: 'text/plain', url: 'https://www.redir.ng/robots.txt', body: '' };
  if (url === 'https://redir.ng/') return { status: 200, type: 'text/html', url: 'https://www.redir.ng/', body: SITES['https://www.redir.ng/'].body };
  const hit = SITES[url];
  if (!hit) return url.includes('down.ng') ? { error: 'ECONNREFUSED' } : { status: 404, type: 'text/html' };
  return { status: hit.status || 200, type: hit.type || 'text/html', body: hit.body, url };
};
const waits = [];
const deps = { find: { get: fake, delayMs: () => 0, wait: async (ms) => { waits.push(ms); } } };

let r = await F.findEmails('acme.ng', { ...deps.find });
check('reads the home, contact and about pages and finds addresses', r.pages.length === 3 && ['hello@acme.ng', 'sales@acme.ng', 'support@acme.ng'].every((e) => r.emails.some((x) => x.email === e)), JSON.stringify(r.pages.map((p) => p.url)));
check('knows which page each address came from', r.emails.find((x) => x.email === 'sales@acme.ng')?.page === 'https://acme.ng/contact');
check('stays on the site, skips images, blog posts and pages robots.txt disallows', !asked.some((a) => /other\.com|logo\.png|blog|\/admin\/contact/.test(a.url)));
check('says who it is', asked.every((a) => /^WynmailFinder\/1\.0/.test(a.ua)));
check('keeps free-mail and third-party addresses in the result for the runner to judge', r.emails.some((x) => x.email === 'boss@gmail.com') && r.emails.some((x) => x.email === 'hi@webagency.io'));
check('blocked by robots.txt: not a single page is fetched', (asked.length = 0, r = await F.findEmails('blocked.ng', { ...deps.find }), r.blocked === true && asked.length === 1 && asked[0].url.endsWith('/robots.txt')));
asked.length = 0; waits.length = 0;
r = await F.findEmails('slow.ng', { ...deps.find });
check('obeys Disallow and Crawl-delay (waits at least 6 seconds between requests)', !asked.some((a) => a.url.endsWith('/contact')) && waits.length >= 2 && waits.every((w) => w >= 6000), waits.join());
check('a robots.txt server error means the site is skipped', (await F.findEmails('bad500.ng', { ...deps.find })).error === 'robots_unreachable');
check('a site that does not answer is reported, not crashed on', (await F.findEmails('down.ng', { ...deps.find })).error === 'unreachable');
check('a home page that is missing is reported', !!(await F.findEmails('nopage.ng', { ...deps.find })).note);
check('redirects to www are followed for the same site', (await F.findEmails('redir.ng', { ...deps.find })).emails.some((x) => x.email === 'sales@redir.ng'));
const d = F.defaultDelay();
check('default pause is between 2 and 3 seconds', d >= 2000 && d <= 3000);
waits.length = 0; asked.length = 0;
await F.findEmails('acme.ng', { get: fake, wait: async (ms) => { waits.push(ms); } });
check('a pause comes before every request except the first', waits.length === asked.length - 1 && waits.every((w) => w >= 2000 && w <= 3000), `${waits.length}/${asked.length}`);
check('stops when asked to', (asked.length = 0, (await F.findEmails('acme.ng', { ...deps.find, shouldStop: () => true })).note === 'stopped'));

/* ---------- reading sites from text and CSV ---------- */
const rs = P.readSites({ text: 'acme.ng\nhttps://www.Acme.ng/about\n127.0.0.1\nlocalhost, shop.de ; nonsense', csv: 'Name,Website\nA,beta.ng\nB,https://beta.ng/x\nC,gamma.com' });
check('text and CSV become one clean list, one per company', rs.sites.join() === 'https://acme.ng,https://shop.de,https://beta.ng,https://gamma.com', rs.sites.join());
check('bad entries are listed with a reason', rs.rejected.length === 3 && rs.rejected.every((x) => x.reason));
check('a CSV without a header uses the first column', P.readSites({ csv: 'delta.ng,x\nepsilon.ng,y' }).sites.length === 2);

/* ---------- the runner ---------- */
const ws = await one(`INSERT INTO workspaces (name, slug, from_email, sending_domain, footer_address) VALUES ('T', 'testws', 'a@t.ng', 't.ng', 'x') RETURNING *`);
const ws2 = await one(`INSERT INTO workspaces (name, slug) VALUES ('Other', 'other') RETURNING *`);
await query(`INSERT INTO contacts (workspace_id, email, status) VALUES ($1, 'known@dup.ng', 'subscribed'), ($1, 'gone@dup.ng', 'unsubscribed')`, [ws.id]);
await query(`INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1, 'new@dup.ng', 'bounced')`, [ws.id]);
const job = await P.createJob(ws.id, null, ['https://acme.ng', 'https://dup.ng', 'https://shop.de', 'https://blocked.ng', 'https://empty.ng', 'https://down.ng', 'https://mailinator.com'], { perCompany: 0 });
check('only one search at a time per workspace', await P.createJob(ws.id, null, ['https://x.ng']).then(() => false, (e) => e.status === 409));
SITES['https://mailinator.com/robots.txt'] = { status: 404 };
SITES['https://mailinator.com/'] = { body: page('postmaster@mailinator.com team@mailinator.com') };
await P.runNextJob(deps);
const d1 = await P.jobDetail(ws.id, job.id);
const by = (email) => d1.results.find((x) => x.email === email);
check('the job finishes', d1.job.status === 'done' && d1.job.done_sites === 7, JSON.stringify(d1.job));
check('good new business addresses are saved', ['hello@acme.ng', 'sales@acme.ng', 'support@acme.ng', 'boss@gmail.com'].every((e) => by(e)?.status === 'saved' && by(e).still_saved));
check('Gmail and other free inboxes printed on the site are collected too', by('boss@gmail.com')?.status === 'saved' && by('boss@gmail.com').still_saved);
check('addresses of other companies on the page are ignored', !by('hi@webagency.io'));
check('EU addresses are not collected', by('info@shop.de')?.status === 'eu');
check('people already in your contacts are not added again', by('known@dup.ng')?.status === 'duplicate');
check('people who unsubscribed or bounced are never added', by('gone@dup.ng')?.status === 'suppressed' && by('new@dup.ng')?.status === 'suppressed');
check('disposable addresses are refused', by('team@mailinator.com')?.status === 'invalid');
check('a site that blocks robots is marked and nothing is read', d1.sites.find((s) => s.url === 'https://blocked.ng').status === 'blocked' && !by('secret@blocked.ng'));
check('a dead site is marked failed, an empty one done with a note', d1.sites.find((s) => s.url === 'https://down.ng').status === 'failed' && d1.sites.find((s) => s.url === 'https://empty.ng').note?.includes('No business email'));
const c = await one(`SELECT * FROM contacts WHERE email = 'sales@acme.ng'`);
check('each saved contact records where it came from', c.consent_source === 'prospector' && c.source_url === 'https://acme.ng/contact' && !!c.source_found_at && c.consent_at === null && c.tags.includes('prospect'));
const plist = await one(`SELECT * FROM lists WHERE workspace_id = $1 AND kind = 'prospects'`, [ws.id]);
check('they sit on a list called Prospects', plist?.name === 'Prospects' && (await one(`SELECT count(*)::int AS n FROM list_contacts WHERE list_id = $1`, [plist.id])).n === 4);
check('the counters add up', d1.job.saved === 4 && d1.job.found === d1.results.length);
check('another workspace sees nothing', (await P.jobDetail(ws2.id, job.id)) === null);


/* ---------- richer leads ---------- */
const meta = F.extractMeta('<html><head><title>Home | Pair Ltd</title><meta property="og:site_name" content="Pair &amp; Sons"><script type="application/ld+json">{"@type":"LocalBusiness","name":"Pair Ventures Ltd","telephone":"+234 803 000 1111","email":"hello@pair.ng"}</script></head><a href="tel:+234 80 1234 5678">x</a></html>');
check('reads the business name, phone and email from structured data', meta.company === 'Pair Ventures Ltd' && meta.phone === '+234 803 000 1111' && meta.emails.includes('hello@pair.ng'), JSON.stringify(meta));
check('falls back to the site name, then the page title', F.extractMeta('<meta property="og:site_name" content="Pair &amp; Sons"><title>Home</title>').company === 'Pair & Sons' && F.extractMeta('<title>Home | Acme Bakery Ltd</title>').company === 'Acme Bakery Ltd' && F.extractMeta('<title>Welcome</title>').company === null);
check('broken structured data does not stop anything', F.extractMeta('<script type="application/ld+json">{nope</script><title>Zed Co</title>').company === 'Zed Co');
check('named people, shared addresses and the rest are told apart', F.classifyAddress('ada.obi@x.ng').kind === 'person' && F.classifyAddress('ada.obi@x.ng').first_name === 'Ada' && F.classifyAddress('info@x.ng').kind === 'role' && F.classifyAddress('sales.team@x.ng').kind === 'role' && F.classifyAddress('chidi@x.ng').kind === 'other' && F.classifyAddress('ceo.office@x.ng').kind === 'role');
check('better leads score higher', F.scoreLead({ kind: 'person', company: 'A', phone: '1' }) > F.scoreLead({ kind: 'person' }) && F.scoreLead({ kind: 'person' }) > F.scoreLead({ kind: 'role' }) && F.scoreLead({ kind: 'role' }) > F.scoreLead({ kind: 'role', free: true }));
check('a site with no contact link: the sitemap finds the page', (asked.length = 0, r = await F.findEmails('hidden.ng', { ...deps.find }), r.emails.some((x) => x.email === 'lead@hidden.ng') && asked.some((a) => a.url.endsWith('/sitemap.xml')) && !asked.some((a) => /shop\/item/.test(a.url))), JSON.stringify(r.pages));

/* ---------- finding businesses ---------- */
check('a query is built from a type, a city and a country', /ISO3166-1"="NG".*name"="Abuja".*amenity"="restaurant/.test(D.buildQuery({ category: 'restaurants', city: 'Abuja', country: 'NG' })));
const bad = (o) => { try { D.buildQuery({ category: 'restaurants', city: 'Abuja', country: 'NG', ...o }); return false; } catch { return true; } };
check('nothing typed can change the query', bad({ city: 'Abuja"]; out;' }) && bad({ city: 'A\\"x' }) && bad({ city: '' }) && bad({ city: 'x'.repeat(80) }) && bad({ country: 'XX' }) && bad({ category: 'rm -rf' }) && !bad({ city: "Port Harcourt" }) && !bad({ city: "N'Djamena" }) && !bad({ city: 'Ibadan-North' }));
const osm = { elements: [
  { type: 'node', id: 1, tags: { name: 'Mama Put', website: 'https://www.mamaput.ng/menu', phone: '+234 1; +234 2', 'addr:city': 'Abuja' } },
  { type: 'node', id: 2, tags: { name: 'Mama Put Annex', website: 'mamaput.ng' } },
  { type: 'way', id: 3, tags: { name: 'Facebook Only', website: 'https://facebook.com/page' } },
  { type: 'node', id: 4, tags: { name: 'Email Only', email: 'hello@emailonly.ng;other@x.ng' } },
  { type: 'node', id: 5, tags: { website: 'https://noname.ng' } },
  { type: 'node', id: 6, tags: { name: 'Nothing' } },
  { type: 'node', id: 7, tags: { name: 'Local', website: 'http://127.0.0.1/x' } }
] };
const biz = D.readBusinesses(osm, { city: 'Abuja', category: 'restaurants' });
check('businesses are read, deduped by website, social pages and nameless ones dropped', biz.length === 2 && biz[0].website === 'https://www.mamaput.ng' && biz[0].phone === '+234 1' && biz[1].email === 'hello@emailonly.ng' && biz[1].website === null, JSON.stringify(biz));
check('every business remembers its map page', biz.every((b) => /^https:\/\/www\.openstreetmap\.org\/(node|way)\/\d+$/.test(b.listed_page)));
let sentUrl = '';
const found = await D.discoverBusinesses({ category: 'hotels', city: 'Lagos', country: 'NG' }, { get: async (u, o) => { sentUrl = u; return { status: 200, type: 'application/json', body: JSON.stringify(osm), ua: o.userAgent }; } });
check('a search asks the public map servers politely and returns businesses', found.total === 2 && sentUrl.startsWith('https://overpass-api.de/api/interpreter?data=') && !sentUrl.includes('"') );
check('if the first map server fails the second is tried', (await D.discoverBusinesses({ category: 'hotels', city: 'Lagos', country: 'NG' }, { get: (() => { let n = 0; return async () => (++n === 1 ? { status: 504 } : { status: 200, type: 'application/json', body: JSON.stringify(osm) }); })() })).total === 2);
check('and a clear error if none answer', await D.discoverBusinesses({ category: 'hotels', city: 'Lagos', country: 'NG' }, { get: async () => ({ error: 'ETIMEOUT' }) }).then(() => false, (e) => e.status === 502));

/* ---------- saving richer leads ---------- */
const ws3 = await one(`INSERT INTO workspaces (name, slug) VALUES ('Third', 'third') RETURNING *`);
const j3 = await P.createJob(ws3.id, null, ['https://pair.ng'], { perCompany: 2 });
await P.runNextJob(deps);
const d3 = await P.jobDetail(ws3.id, j3.id);
const by3 = (e) => d3.results.find((x) => x.email === e);
check('the two best addresses at a company are kept, the rest held back', d3.results.filter((x) => x.status === 'saved').length === 2 && d3.results.filter((x) => x.status === 'extra').length >= 2, JSON.stringify(d3.results.map((x) => [x.email, x.status, x.score])));
check('named people come first', by3('ada.obi@pair.ng')?.status === 'saved' && by3('ben.eze@pair.ng')?.status === 'saved' && by3('ada.obi@pair.ng').kind === 'person');
check('shared addresses are marked as such', by3('info@pair.ng')?.kind === 'role' && by3('info@pair.ng')?.status === 'extra');
const ada = await one(`SELECT * FROM contacts WHERE workspace_id = $1 AND email = 'ada.obi@pair.ng'`, [ws3.id]);
check('the contact gets a name, company, phone and where it came from', ada.first_name === 'Ada' && ada.last_name === 'Obi' && ada.attributes.company === 'Pair Ventures Ltd' && ada.attributes.phone === '+234 803 000 1111' && ada.attributes.website === 'https://pair.ng' && ada.tags.includes('person') && ada.tags.includes('prospect'), JSON.stringify(ada));
check('so an email can say their name and company', merge('Hi {{first_name|there}}, about {{company}}', ada) === 'Hi Ada, about Pair Ventures Ltd');
check('the results table can rank by score', d3.results[0].status === 'saved' && d3.results[0].score >= d3.results[1].score);
check('the owner@pair.ng address in the structured data was found too', !!by3('owner@pair.ng'));

await query(`UPDATE prospect_jobs SET status = 'done' WHERE workspace_id = $1`, [ws3.id]);
const listed = { url: 'https://www.openstreetmap.org/node/9', company: 'Mama Put', phone: '+234 1', category: 'Restaurants and cafes', city: 'Abuja', email: 'mama@mamaput.ng', listed_page: 'https://www.openstreetmap.org/node/9' };
asked.length = 0;
const j4 = await P.createJob(ws3.id, null, [listed, { url: 'https://empty.ng', company: 'Empty Co', email: 'owner@empty.ng', listed_page: 'https://www.openstreetmap.org/node/10' }], { perCompany: 1 });
await P.runNextJob(deps);
const d4 = await P.jobDetail(ws3.id, j4.id);
check('a business listed with only an email is saved without visiting anything', d4.results.find((x) => x.email === 'mama@mamaput.ng')?.status === 'saved' && !asked.some((a) => /openstreetmap/.test(a.url)));
check('its page, company and city are recorded', (await one(`SELECT source_url, attributes FROM contacts WHERE email = 'mama@mamaput.ng'`)).source_url === 'https://www.openstreetmap.org/node/9' && (await one(`SELECT attributes FROM contacts WHERE email = 'mama@mamaput.ng'`)).attributes.company === 'Mama Put');
check('an email from the map is used even when the website shows none', d4.results.find((x) => x.email === 'owner@empty.ng')?.status === 'saved');

/* ---------- keeping prospects apart ---------- */
const news = await one(`INSERT INTO lists (workspace_id, name) VALUES ($1, 'Newsletter') RETURNING id`, [ws.id]);
await attachLists(ws.id, c.id, [news.id], { source: 'manual' });
check('a prospect can never be put on a normal list', (await one(`SELECT count(*)::int AS n FROM list_contacts WHERE list_id = $1`, [news.id])).n === 0);
const sub = await one(`INSERT INTO contacts (workspace_id, email, consent_source) VALUES ($1, 'fan@acme.ng', 'form') RETURNING id`, [ws.id]);
await attachLists(ws.id, sub.id, [plist.id], { source: 'form' });
check('a person who signed up can never be put on Prospects', (await one(`SELECT count(*)::int AS n FROM list_contacts WHERE list_id = $1 AND contact_id = $2`, [plist.id, sub.id])).n === 0);
await attachLists(ws.id, sub.id, [news.id], { source: 'form' });
check('normal lists still work for them', (await one(`SELECT count(*)::int AS n FROM list_contacts WHERE list_id = $1`, [news.id])).n === 1);

/* ---------- limits and cancel ---------- */
const big = Array.from({ length: P.DAILY_SITES }, (_, i) => `https://s${i}.ng`);
check('a daily limit protects the sender reputation', await P.createJob(ws.id, null, big).then(() => false, (e) => e.status === 429 || e.status === 409));
const j2 = await P.createJob(ws2.id, null, ['https://acme.ng', 'https://dup.ng']);
const cancelled = await P.cancelJob(ws2.id, j2.id);
await P.runNextJob(deps);
const d2 = await P.jobDetail(ws2.id, j2.id);
check('a cancelled search reads nothing more', cancelled?.status === 'cancelled' && d2.job.status === 'cancelled' && d2.sites.every((s) => s.status === 'skipped') && d2.results.length === 0);
check('another workspace cannot cancel it', (await P.cancelJob(ws.id, j2.id)) === null);

/* ---------- the page fetcher ---------- */
const srv = http.createServer((req, res) => {
  if (req.url === '/gz') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync('<p>zipped hello@x.ng</p>')); }
  if (req.url === '/redir') { res.writeHead(301, { location: '/gz' }); return res.end(); }
  if (req.url === '/away') { res.writeHead(302, { location: 'http://other.example/' }); return res.end(); }
  if (req.url === '/img') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end('x'); }
  if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('a'.repeat(3000000)); }
  if (req.url === '/hang') return undefined;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<p>plain</p>');
}).listen(0);
await new Promise((r2) => srv.on('listening', r2));
const base = `http://127.0.0.1:${srv.address().port}`;
const priv = { allowPrivate: true };
check('private addresses are refused', (await fetchPage(`${base}/`)).error === 'EBLOCKED' && (await fetchPage('http://localhost/')).error);
check('reads a page', (await fetchPage(`${base}/`, priv)).body === '<p>plain</p>');
check('reads a gzipped page', (await fetchPage(`${base}/gz`, priv)).body.includes('zipped hello@x.ng'));
check('follows a redirect only when allowed', (await fetchPage(`${base}/redir`, { ...priv, allowRedirect: () => true })).body.includes('zipped') && (await fetchPage(`${base}/redir`, priv)).error === 'EREDIRECT');
check('does not follow a redirect to another site', (await fetchPage(`${base}/away`, { ...priv, allowRedirect: (a, b) => a.hostname === b.hostname })).error === 'EREDIRECT');
check('skips pictures and other non-text', (await fetchPage(`${base}/img`, priv)).body === undefined);
check('stops reading a huge page', (await fetchPage(`${base}/big`, { ...priv, maxBytes: 100000 })).truncated === true);
check('gives up on a page that never answers', (await fetchPage(`${base}/hang`, { ...priv, timeout: 300 })).error === 'ETIMEOUT');
check('refuses logins in the address and odd ports', (await fetchPage('http://user:pw@example.com/')).error === 'EBLOCKED' && (await fetchPage('http://example.com:8080/')).error === 'EBLOCKED');
srv.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
