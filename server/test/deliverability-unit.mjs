// Pure tests for list hygiene, the pre-send check, warm-up, the link guard and plain text. Needs nothing running.
import http from 'node:http';
import { isDisposable, isRole, typoFor, mxStatus, assessEmail, assessMany, groupProblems, clearMxCache } from '../src/hygiene.js';
import { analyze, score, mergeFieldsUsed, reputationItems, mergeGapItems, classifyProbe, linkItems, uniqueWebLinks, domainItems } from '../src/precheck.js';
import { capForDay, warmupDay, warmupLimit, healthHold, schedule, daysToSend } from '../src/warmup.js';
import { isPrivateIp, probe } from '../src/safefetch.js';
import { htmlToText } from '../src/text.js';
import { buildEmail } from '../src/render.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const ids = (items) => items.map((i) => i.id);
const err = (code) => Object.assign(new Error(code), { code });

/* ---------- hygiene ---------- */
check('disposable domains are caught, including subdomains', isDisposable('mailinator.com') && isDisposable('x.y.mailinator.com') && !isDisposable('gmail.com') && !isDisposable('mailinator.com.au'));
check('role addresses are caught, personal ones are not', isRole('info@x.com') && isRole('Support+news@x.com') && !isRole('ada.info@x.com') && !isRole('ada@x.com'));
check('typos of big providers get a suggestion', typoFor('ada@gmial.com') === 'ada@gmail.com' && typoFor('b@yahoo.con') === 'b@yahoo.com' && typoFor('ada@gmail.com') === null);

const R = (map) => ({
  resolveMx: async (d) => { const v = map[d]?.mx; if (v instanceof Error) throw v; if (v) return v; throw err('ENODATA'); },
  resolve4: async (d) => { const v = map[d]?.a; if (v instanceof Error) throw v; if (v) return v; throw err('ENOTFOUND'); }
});
clearMxCache();
const fake = R({
  'good.com': { mx: [{ exchange: 'mx.good.com', priority: 10 }] },
  'aonly.com': { a: ['1.2.3.4'] },
  'nullmx.com': { mx: [{ exchange: '', priority: 0 }] },
  'slow.com': { mx: err('ETIMEOUT') },
  'servfail.com': { mx: err('ESERVFAIL') }
});
check('a domain with MX records is ok', (await mxStatus('good.com', fake)) === 'ok');
check('a domain with only an address record is ok', (await mxStatus('aonly.com', fake)) === 'ok');
check('a null MX domain cannot receive mail', (await mxStatus('nullmx.com', fake)) === 'none');
check('a domain that does not exist cannot receive mail', (await mxStatus('ghost.com', fake)) === 'none');
check('a failed lookup is unknown and never blocks', (await mxStatus('slow.com', fake)) === 'unknown' && (await mxStatus('servfail.com', fake)) === 'unknown');
check('reserved names are rejected without a lookup', (await mxStatus('anything.invalid', { resolveMx: () => { throw new Error('should not look up'); } })) === 'none');

const pol = { block_disposable: true, block_role: false, check_mx: true };
const asses = (e, p = pol) => assessEmail(e, p, { resolver: fake, checkMx: true });
check('a normal address passes', (await asses('ada@good.com')).ok === true);
check('a typo is refused with the fix', (await asses('ada@gmial.com')).suggestion === 'ada@gmail.com');
check('a disposable address is refused', (await asses('x@mailinator.com')).code === 'disposable');
check('a disposable address is allowed when the workspace allows it', (await asses('x@mailinator.com', { ...pol, block_disposable: false, check_mx: false })).ok === true);
check('a role address passes by default and is refused when blocked', (await asses('info@good.com')).ok === true && (await asses('info@good.com', { ...pol, block_role: true })).code === 'role');
check('a dead domain is refused', (await asses('ada@ghost.com')).code === 'no_mx');
check('a dead domain is allowed when the MX check is off', (await asses('ada@ghost.com', { ...pol, check_mx: false })).ok === true);
check('an unknown lookup never blocks a signup', (await asses('ada@slow.com')).ok === true);

let lookups = 0;
const counting = { resolveMx: async () => { lookups += 1; return [{ exchange: 'm', priority: 1 }]; }, resolve4: async () => [] };
clearMxCache();
const many = await assessMany(['a@same.com', 'b@same.com', 'c@same.com', 'd@other.com', 'x@mailinator.com', 'e@gmial.com'], pol, { resolver: counting, checkMx: true });
check('each domain is looked up once however many addresses share it', lookups === 2, String(lookups));
check('bulk results line up with the input', many.map((r) => r.ok).join() === 'true,true,true,true,false,false' && many[4].code === 'disposable' && many[5].code === 'typo');

clearMxCache();
const grouped = await groupProblems(
  [{ id: 1, email: 'ok@good.com' }, { id: 2, email: 'info@good.com' }, { id: 3, email: 'z@mailinator.com' }, { id: 4, email: 'q@ghost.com' }, { id: 5, email: 'p@gmial.com' }, { id: 6, email: 'r@slow.com' }],
  { resolver: fake, checkMx: true });
check('list health groups every problem kind', grouped.groups.disposable.length === 1 && grouped.groups.no_mx.length === 1 && grouped.groups.typo.length === 1 && grouped.groups.role.length === 1, JSON.stringify(Object.fromEntries(Object.entries(grouped.groups).map(([k, v]) => [k, v.length]))));
check('an unknown lookup is not counted as a dead domain', !grouped.groups.no_mx.some((r) => r.id === 6));

/* ---------- pre-send check ---------- */
const ws = { from_email: 'a@b.com', sending_domain: 'b.com', footer_address: 'Abuja' };
const good = analyze({ subject: 'Your October update', html: '<h1>Hello {{first_name|there}}</h1><p>We shipped three things this month and wanted you to know about them first. Read the <a href="https://b.com/news">full update</a> when you have a minute.</p><img src="x" alt="Team">', workspace: ws, renderedBytes: 9000 });
check('a clean email scores well', score(good).verdict === 'good' && score(good).score >= 85, JSON.stringify(score(good)));
const bad = analyze({ subject: 'FREE MONEY!!! ACT NOW', html: '<p>CLICK HERE <a href="javascript:alert(1)">x</a> <a href="http://bit.ly/abc">click here</a> <a href="https://evil.example">paypal.com</a> <a href="#">go</a></p><img src="a"><img src="b" alt="">', workspace: ws });
const badIds = ids(bad);
check('a spammy subject is flagged', badIds.includes('subject_punct') && badIds.includes('subject_spam') && badIds.includes('subject_caps'), badIds.join());
check('script links, shorteners, plain http, dead anchors and vague text are flagged', ['link_script', 'link_shortener', 'link_http', 'link_empty', 'link_vague'].every((x) => badIds.includes(x)), badIds.join());
check('a link that shows one address and opens another is a failure', bad.find((i) => i.id === 'link_mismatch')?.level === 'fail');
check('pictures without descriptions are flagged', badIds.includes('alt_missing') && badIds.includes('image_heavy'));
check('a risky email gets the risky verdict', score(bad).verdict === 'risky' && score(bad).score < 60);
check('www and the bare domain count as the same site', !ids(analyze({ subject: 'Hi there friend', html: '<p>words words words words words words words words words words words words words words words words words words words words words words words words words <a href="https://www.b.com/x">b.com/x</a></p>', workspace: ws })).includes('link_mismatch'));
check('an empty subject and empty body fail', ids(analyze({ subject: '', html: '', workspace: ws })).includes('subject_empty') && ids(analyze({ subject: 'x', html: '', workspace: ws })).includes('body_empty'));
check('a broken merge field fails', ids(analyze({ subject: 'Hi {{first_name', html: '<p>Hello there friend, this is long enough text.</p>', workspace: ws })).includes('merge_broken'));
check('an email over 100 KB is a failure, over 80 KB a warning', analyze({ subject: 'Hi there', html: '<p>hello there everyone</p>', workspace: ws, renderedBytes: 110000 }).some((i) => i.id === 'size_clipped' && i.level === 'fail') && analyze({ subject: 'Hi there', html: '<p>hello there everyone</p>', workspace: ws, renderedBytes: 85000 }).some((i) => i.id === 'size_large'));
check('a missing sender or footer address fails', ids(analyze({ subject: 'Hi there', html: '<p>hello there everyone</p>', workspace: {} })).includes('sender_missing') && ids(analyze({ subject: 'Hi there', html: '<p>hello there everyone</p>', workspace: {} })).includes('footer_missing'));
check('merge fields are found, with and without fallbacks', JSON.stringify(mergeFieldsUsed('Hi {{first_name|there}}', '{{company}} {{first_name}} {{footer}}')) === JSON.stringify([{ key: 'first_name', hasFallback: false }, { key: 'company', hasFallback: false }]), JSON.stringify(mergeFieldsUsed('Hi {{first_name|there}}', '{{company}} {{first_name}} {{footer}}')));
check('a field with a fallback everywhere is not reported', mergeGapItems([{ key: 'first_name', hasFallback: true, missing: 4, total: 10 }]).length === 0 && mergeGapItems([{ key: 'first_name', hasFallback: false, missing: 4, total: 10 }])[0].title.startsWith('4 of 10'));
check('bounce and spam rates are judged by the right thresholds',
  reputationItems({ sent: 1000, bounced: 10, complained: 0 })[0].level === 'pass'
  && reputationItems({ sent: 1000, bounced: 30, complained: 0 })[0].level === 'warn'
  && reputationItems({ sent: 1000, bounced: 80, complained: 0 })[0].level === 'fail'
  && reputationItems({ sent: 1000, bounced: 0, complained: 4 })[0].level === 'fail'
  && reputationItems({ sent: 20, bounced: 20, complained: 20 }).length === 0);
check('missing SPF, DKIM or DMARC fails, a healthy domain passes',
  domainItems([{ key: 'dkim', status: 'missing', detail: 'x' }]).some((i) => i.level === 'fail') && domainItems([{ key: 'dkim', status: 'ok' }, { key: 'spf', status: 'ok' }, { key: 'dmarc', status: 'warn' }])[0].id === 'dns_ok');
check('link results are classified', classifyProbe('u', { status: 404 }).verdict === 'dead' && classifyProbe('u', { status: 503 }).verdict === 'dead' && classifyProbe('u', { status: 403 }).verdict === 'ok' && classifyProbe('u', { status: 301 }).verdict === 'ok' && classifyProbe('u', { error: 'ENOTFOUND' }).verdict === 'dead' && classifyProbe('u', { error: 'ETIMEOUT' }).verdict === 'slow' && classifyProbe('u', { error: 'EBLOCKED' }).verdict === 'dead');
check('broken links produce a failure', linkItems([{ url: 'https://a.com', verdict: 'dead', reason: 'x' }])[0].level === 'fail');
check('only web links with no merge fields are probed, once each', JSON.stringify(uniqueWebLinks('<a href="https://a.com">1</a><a href="https://a.com">2</a><a href="mailto:x@y.com">3</a><a href="https://b.com/{{id}}">4</a>')) === '["https://a.com"]');

/* ---------- warm-up ---------- */
const W = { warmup_enabled: true, warmup_started_at: new Date('2026-10-01T10:00:00Z'), warmup_start_volume: 50, warmup_growth: 2, daily_limit: 1000 };
check('the cap doubles each day', [1, 2, 3, 4, 5].map((d) => capForDay(W, d)).join() === '50,100,200,400,800');
check('the day counts from the start date', warmupDay(W, new Date('2026-10-01T23:00:00Z')) === 1 && warmupDay(W, new Date('2026-10-04T01:00:00Z')) === 4 && warmupDay({ ...W, warmup_enabled: false }) === null);
check('the cap never goes above the daily limit', warmupLimit(W, null, new Date('2026-10-07T00:00:00Z')).limit === 1000 && warmupLimit(W, null, new Date('2026-10-07T00:00:00Z')).done === true);
check('while warming up the limit is the day cap', warmupLimit(W, null, new Date('2026-10-03T00:00:00Z')).limit === 200 && warmupLimit(W, null, new Date('2026-10-03T00:00:00Z')).active === true);
check('with warm-up off the plain daily limit applies', warmupLimit({ ...W, warmup_enabled: false }, null).limit === 1000);
check('a bad yesterday holds growth', healthHold({ sent: 100, bounced: 10, complained: 0 }) && healthHold({ sent: 100, bounced: 0, complained: 1 }) && !healthHold({ sent: 100, bounced: 2, complained: 0 }) && !healthHold({ sent: 20, bounced: 20, complained: 0 }));
const held = warmupLimit(W, { sent: 100, bounced: 10, complained: 0 }, new Date('2026-10-04T00:00:00Z'));
check('a held day sends no more than yesterday', held.limit === 100 && held.hold, JSON.stringify(held));
check('the schedule lists upcoming days capped at the limit', schedule(W, 6, new Date('2026-10-01T00:00:00Z')).map((d) => d.cap).join() === '50,100,200,400,800,1000');
check('send time is spread across days', daysToSend(500, W, 50, new Date('2026-10-01T00:00:00Z')) === 4 && daysToSend(30, W, 50) === 1, String(daysToSend(500, W, 50, new Date('2026-10-01T00:00:00Z'))));

/* ---------- link guard ---------- */
check('private and internal addresses are recognised', ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'].every(isPrivateIp));
check('public addresses are not', ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700::1111'].every((ip) => !isPrivateIp(ip)));
check('the probe refuses internal targets, odd ports and credentials', (await probe('http://127.0.0.1:4000/health')).error === 'EBLOCKED' && (await probe('http://localhost/')).error === 'EBLOCKED' && (await probe('https://example.com:8443/')).error === 'EBLOCKED' && (await probe('https://user:pw@example.com/')).error === 'EBLOCKED' && (await probe('ftp://example.com/')).error === 'EBLOCKED' && (await probe('http://[::1]/')).error === 'EBLOCKED');
const srv = http.createServer((q, s) => {
  if (q.url === '/ok') { s.statusCode = 200; return s.end('x'); }
  if (q.url === '/gone') { s.statusCode = 404; return s.end(); }
  if (q.url === '/nohead') { s.statusCode = q.method === 'HEAD' ? 405 : 200; return s.end(); }
  if (q.url === '/hang') return; // never answers
  s.statusCode = 302; s.setHeader('Location', 'http://169.254.169.254/'); s.end();
}).listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
check('the probe reads live, missing, head-refusing and redirecting pages', (await probe(`${base}/ok`, { allowPrivate: true })).status === 200 && (await probe(`${base}/gone`, { allowPrivate: true })).status === 404 && (await probe(`${base}/nohead`, { allowPrivate: true })).status === 200 && (await probe(`${base}/redir`, { allowPrivate: true })).status === 302);
check('the probe gives up on a page that never answers', (await probe(`${base}/hang`, { allowPrivate: true, timeout: 500 })).error === 'ETIMEOUT');
srv.close(); srv.closeAllConnections?.();

/* ---------- plain text ---------- */
const t = htmlToText('<style>p{}</style><h1>Hi &amp; welcome</h1><p>Read <a href="https://x.co/a?b=1&amp;c=2">our post</a> or <a href="https://x.co">https://x.co</a></p><ul><li>One</li><li>Two</li></ul><img src="a" alt="Logo">');
check('plain text keeps link addresses, lists and picture descriptions', t.includes('our post (https://x.co/a?b=1&c=2)') && t.includes('- One') && t.includes('- Two') && t.includes('Logo') && !t.includes('p{}') && !t.includes('<'), t);
const built = buildEmail({ workspace: { name: 'W', footer_address: '1 Main St, Abuja', tracking_domain: '' }, contact: { email: 'a@b.com', first_name: 'Ada', attributes: {} }, subject: 'Hi', html: '<p>Hello {{first_name}}, <a href="https://b.com/x">see this</a></p>', token: 'tok' });
check('every email carries a real text part with the original link, address and unsubscribe link', built.text.includes('see this (https://b.com/x)') && built.text.includes('Hello Ada') && built.text.includes('1 Main St, Abuja') && /Unsubscribe: http\S+\/t\/u\/tok/.test(built.text) && !built.text.includes('/t/c/'), built.text);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
