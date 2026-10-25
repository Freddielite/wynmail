import net from 'node:net';
import { fetchPage } from './safefetch.js';

// Finds business email addresses printed on a company's own website.
// Polite by design: obeys robots.txt (and Crawl-delay), waits 2 to 3 seconds between requests, reads at most a few
// pages (home, contact, about, team), and never leaves the site. It only reads what the site prints for anyone to see.

export const USER_AGENT_TOKEN = 'wynmailfinder';
export const userAgent = () => process.env.PROSPECT_UA
  || `WynmailFinder/1.0 (business email finder; contact ${process.env.SECURITY_CONTACT || process.env.ADMIN_EMAIL || 'see the sender\'s website'})`;

/* ---------- addresses ---------- */
const FREE = new Set(['gmail.com', 'googlemail.com', 'ymail.com', 'rocketmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'mail.com', 'gmx.com', 'gmx.net', 'gmx.de', 'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru', 'mail.ru',
  'qq.com', '163.com', '126.com', 'inbox.com', 'rediffmail.com', 'tutanota.com', 'tuta.io', 'hey.com', 'fastmail.com', 'web.de', 'orange.fr', 'wanadoo.fr', 'free.fr']);
export const isFreemail = (domain) => {
  const d = String(domain).toLowerCase();
  return FREE.has(d) || /^(yahoo|hotmail|outlook|live|msn)\.[a-z.]{2,}$/.test(d);
};

const EU = new Set('at be bg hr cy cz dk ee fi fr de gr hu ie it lv lt lu mt nl pl pt ro sk si es se eu'.split(' '));
// Judged from the address ending only. A .com business based in the EU cannot be detected, so the page says so.
export const isEuDomain = (domain) => EU.has(String(domain).toLowerCase().split('.').pop());

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'sch']);
export function registrableDomain(host) {
  const labels = String(host).toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const [tld, sld] = [labels[labels.length - 1], labels[labels.length - 2]];
  return labels.slice(tld.length === 2 && SECOND_LEVEL.has(sld) ? -3 : -2).join('.');
}

const BAD_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|abuse|privacy|dpo|unsubscribe|bounces?|root|user(name)?|name|email|e-?mail|your-?(name|email)|you|test|example|sample|first\.?last|john\.?doe|jane\.?doe)$/i;
const BAD_DOMAIN = /(^|\.)(example\.(com|org|net)|domain\.com|yourdomain\.[a-z]+|email\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|localhost)$/i;
const FILE_TLD = /^(png|jpe?g|gif|svg|webp|avif|css|js|mjs|woff2?|ttf|eot|ico|pdf|zip|map|json|xml|php|html?)$/i;

export function cleanCandidate(raw) {
  let e = String(raw || '').trim().toLowerCase().replace(/^[<("'\s]+|[>)"',;:.\s]+$/g, '');
  const at = e.lastIndexOf('@');
  if (at < 1 || e.length > 254) return null;
  const local = e.slice(0, at), domain = e.slice(at + 1);
  if (local.length > 64 || !/^[a-z0-9._%+'-]+$/.test(local) || /^\.|\.$|\.\./.test(local)) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) || /(^-|-$|\.-|-\.)/.test(domain)) return null;
  const tld = domain.split('.').pop();
  if (!/^[a-z]{2,24}$/.test(tld) || FILE_TLD.test(tld) || BAD_DOMAIN.test(domain) || BAD_LOCAL.test(local.split('+')[0])) return null;
  if (/^[0-9a-f]{24,}$/.test(local) || /^\d+x$/.test(local)) return null; // hashes and image names like "logo@2x"
  return `${local}@${domain}`;
}

const ENTITIES = { amp: '&', commat: '@', period: '.', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32))
  .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d) || 32))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

// Cloudflare hides addresses as data-cfemail="hex": the first byte is the key. The page prints them for visitors, so we read them too.
const cfDecode = (hex) => {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch { return ''; }
};

export function extractEmails(html) {
  const found = new Set();
  const src = String(html || '');
  for (const m of src.matchAll(/data-cfemail=["']([0-9a-f]{6,})["']/gi)) found.add(cfDecode(m[1]));
  for (const m of src.matchAll(/mailto:([^"'<>\s]+)/gi)) {
    let v = m[1];
    try { v = decodeURIComponent(decodeEntities(v)); } catch { v = decodeEntities(v); }
    for (const part of v.split('?')[0].split(/[,;]/)) found.add(part);
  }
  let text = src.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text)
    .replace(/\s*[\[({]\s*(?:at|@)\s*[\])}]\s*/gi, '@')
    .replace(/\s*[\[({]\s*dot\s*[\])}]\s*/gi, '.');
  for (const m of text.matchAll(/[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi)) found.add(m[0]);
  return [...found].map(cleanCandidate).filter(Boolean);
}

/* ---------- who they are: name, phone, address type ---------- */
const GENERIC_TITLE = /^(home|homepage|welcome|welcome to|official( web)?site|main|index|contact( us)?|about( us)?|untitled|just another.*)$/i;
const decode = (s) => decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim();

function walkJsonLd(node, out, depth = 0) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) { node.forEach((n) => walkJsonLd(n, out, depth + 1)); return; }
  if (typeof node !== 'object') return;
  const type = [].concat(node['@type'] || []).join(' ');
  if (typeof node.email === 'string') out.emails.push(node.email.replace(/^mailto:/i, ''));
  if (typeof node.telephone === 'string') out.phones.push(node.telephone);
  if (typeof node.name === 'string' && /Organization|LocalBusiness|Store|Restaurant|Hotel|Corporation|Company|Clinic|School|Service|Professional/i.test(type)) out.names.push(node.name);
  for (const v of Object.values(node)) if (v && typeof v === 'object') walkJsonLd(v, out, depth + 1);
}

// The business name, phone and any address the site puts in its structured data (schema.org), which many sites include for Google.
export function extractMeta(html) {
  const src = String(html || '');
  const ld = { emails: [], phones: [], names: [] };
  for (const m of src.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walkJsonLd(JSON.parse(m[1].trim()), ld); } catch { /* broken JSON: ignore */ }
  }
  const og = src.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || src.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1];
  const title = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  let company = ld.names.map(decode).find((n) => n && n.length <= 80) || (og && decode(og));
  if (!company && title) {
    const parts = decode(title).split(/\s*[|\u2013\u2014\u00b7:]\s*|\s+-\s+/).map((p) => p.trim()).filter((p) => p && !GENERIC_TITLE.test(p));
    company = parts.sort((a, b) => a.length - b.length).find((p) => p.length >= 2 && p.length <= 60) || null;
  }
  const phones = [...ld.phones, ...[...src.matchAll(/href=["']tel:([^"']+)["']/gi)].map((m) => decodeURIComponent(m[1]))]
    .map((p) => p.replace(/[^0-9+()\-\s]/g, '').trim()).filter((p) => p.replace(/\D/g, '').length >= 7 && p.length <= 30);
  return { company: company ? company.slice(0, 80) : null, phone: phones[0] || null, emails: ld.emails.map(cleanCandidate).filter(Boolean) };
}

const ROLE = new Set(('info contact contactus sales hello hi hey support help admin administrator office enquiries enquiry inquiries inquiry mail email team hr careers jobs career recruitment ' +
  'billing accounts account accounting finance marketing booking bookings reservations reservation orders order customerservice customercare service services press media general reception ' +
  'studio shop store manager director ceo md president webmaster feedback welcome partners partnership hello1 enquire us ask').split(' '));

// "person" = a named person (ada.obi@), "role" = a shared address (info@), "other" = anything else.
export function classifyAddress(email) {
  const local = String(email).toLowerCase().split('@')[0].split('+')[0];
  const tokens = local.split(/[._-]+/).filter(Boolean);
  if (tokens.some((t) => ROLE.has(t)) || ROLE.has(local)) return { kind: 'role' };
  if (tokens.length === 2 && tokens.every((t) => /^[a-z]{2,20}$/.test(t))) {
    const cap = (t) => t[0].toUpperCase() + t.slice(1);
    return { kind: 'person', first_name: cap(tokens[0]), last_name: cap(tokens[1]) };
  }
  return { kind: 'other' };
}

// Higher is a better lead: a named person at the company's own domain, with a known company name and a phone.
export function scoreLead({ kind, free = false, company = null, phone = null }) {
  return { person: 50, other: 30, role: 20 }[kind] + (free ? 0 : 20) + (company ? 15 : 0) + (phone ? 5 : 0);
}

/* ---------- pages ---------- */
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|zip|rar|docx?|xlsx?|pptx?|mp[34]|css|js|xml|json)$/i;
const SCORES = [
  [/contact|get-?in-?touch|reach-?us|enquir|inquir|talk-?to|connect-?with/, 10],
  [/about|who-?we-?are|our-?story|company/, 6],
  [/team|people|leadership|staff|management/, 4],
  [/support|help|locations?|offices?|branches/, 3]
];
const sameSite = (a, b) => registrableDomain(a.hostname) === registrableDomain(b.hostname);

// Pages listed in the site's sitemap.xml that look like contact, about or team pages.
export function pagesFromSitemap(xml, baseUrl) {
  const links = [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].slice(0, 2000).map((m) => `<a href="${decodeEntities(m[1])}">`).join('');
  return discoverPages(links, baseUrl);
}

export function discoverPages(html, baseUrl) {
  const base = new URL(baseUrl);
  const seen = new Map();
  for (const m of String(html || '').matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)["']/gi)) {
    let u;
    try { u = new URL(decodeEntities(m[1]).trim(), base); } catch { continue; }
    if (!['http:', 'https:'].includes(u.protocol) || !sameSite(u, base) || u.search || SKIP_EXT.test(u.pathname)) continue;
    const path = u.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    if (path === '/' || path.split('/').length > 4) continue;
    const score = SCORES.reduce((best, [re, s]) => (re.test(path) ? Math.max(best, s) : best), 0);
    if (!score) continue;
    const key = u.origin + path;
    if (!seen.has(key) || seen.get(key).score < score) seen.set(key, { url: u.origin + u.pathname, score, len: path.length });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score || a.len - b.len).map((x) => x.url);
}

/* ---------- robots.txt ---------- */
export function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').match(/^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2];
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') cur.rules.push({ allow: key === 'allow', pattern: val });
    else if (key === 'crawl-delay' && Number.isFinite(Number(val))) cur.delay = Number(val);
  }
  const mine = groups.filter((g) => g.agents.some((a) => a && a !== '*' && USER_AGENT_TOKEN.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return {
    delay: chosen.reduce((d, g) => (g.delay ?? d), null),
    rules: chosen.flatMap((g) => g.rules).filter((r) => r.pattern !== '')
  };
}

const patternRe = (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
export function robotsAllows(robots, pathAndQuery) {
  let best = null;
  for (const r of robots.rules) {
    if (!patternRe(r.pattern).test(pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

/* ---------- a site ---------- */
export function normalizeSite(input) {
  let s = String(input || '').trim();
  if (!s || s.length > 300) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))) return null;
  if (net.isIP(host.replace(/^\[|\]$/g, '')) || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /\.(local|localhost|internal|lan|test|invalid|example)$/.test(host)) return null;
  const tld = host.split('.').pop();
  if (!/^[a-z]{2,24}$/.test(tld) && !/^xn--[a-z0-9-]+$/.test(tld)) return null;
  return { host, origin: `${u.protocol}//${host}`, domain: registrableDomain(host) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const defaultDelay = () => (process.env.PROSPECT_DELAY_MS !== undefined ? Number(process.env.PROSPECT_DELAY_MS) : 2000 + Math.random() * 1000);

// Returns { origin, pages, emails: [{ email, page }], blocked, note, error }.
export async function findEmails(input, { get = fetchPage, delayMs = defaultDelay, wait = sleep, maxPages = 5, shouldStop = () => false } = {}) {
  const site = normalizeSite(input);
  if (!site) return { error: 'invalid_site', note: 'That does not look like a company website address.' };
  const opts = { userAgent: userAgent(), allowRedirect: (from, to) => sameSite(from, to) };
  let requests = 0, extraDelay = 0;
  // One request at a time, with a pause before every request except the first.
  const polite = async (url, o = {}) => {
    if (requests++) await wait(Math.max(delayMs(), extraDelay));
    return get(url, { ...opts, ...o });
  };

  // robots.txt first. 4xx means there are no rules. A server error or no answer means we do not go in.
  let origin = site.origin;
  let robotsRes = await polite(`${origin}/robots.txt`, { accept: 'text/plain' });
  if (robotsRes.error && origin.startsWith('https://')) { origin = origin.replace('https://', 'http://'); robotsRes = await polite(`${origin}/robots.txt`, { accept: 'text/plain' }); }
  if (shouldStop()) return { origin, pages: [], emails: [], note: 'stopped' };
  let robots = { rules: [], delay: null };
  if (robotsRes.error && !robotsRes.status) return { origin, pages: [], emails: [], error: 'unreachable', note: 'The website did not answer.' };
  if (robotsRes.status >= 500) return { origin, pages: [], emails: [], error: 'robots_unreachable', note: 'The site\'s robots.txt could not be read, so it was skipped.' };
  if (robotsRes.status === 200 && robotsRes.body) robots = parseRobots(robotsRes.body);
  if (robots.delay) extraDelay = Math.min(robots.delay, 10) * 1000;
  const allowed = (url) => { const u = new URL(url); return robotsAllows(robots, u.pathname + u.search); };
  if (!allowed(`${origin}/`)) return { origin, pages: [], emails: [], blocked: true, note: 'The site\'s robots.txt does not allow automated visits.' };

  const pages = [], emails = new Map();
  let company = null, phone = null;
  const visit = async (url) => {
    if (shouldStop() || !allowed(url)) return null;
    const r = await polite(url);
    pages.push({ url: r.url || url, status: r.status || 0, error: r.error || null });
    if (r.body) {
      const meta = extractMeta(r.body);
      company = company || meta.company; phone = phone || meta.phone;
      for (const e of [...extractEmails(r.body), ...meta.emails]) if (!emails.has(e)) emails.set(e, r.url || url);
    }
    return r;
  };

  const home = await visit(`${origin}/`);
  if (!home || !home.body) {
    return { origin, pages, emails: [], error: home?.error ? 'unreachable' : 'no_home', note: home?.status ? `The home page could not be read (the site answered ${home.status}).` : 'The home page could not be read.' };
  }
  const base = home.url || `${origin}/`;
  let next = discoverPages(home.body, base).filter((u) => allowed(u));
  // No obvious contact page on the home page? The sitemap usually lists one. One extra request, then common paths as a last resort.
  if (!next.some((u) => /contact|touch|reach|enquir|inquir/i.test(u)) && !shouldStop() && allowed(`${origin}/sitemap.xml`)) {
    const sm = await polite(new URL('/sitemap.xml', base).href, { accept: 'application/xml,text/xml,text/plain', types: /xml|text\// });
    if (sm.body) for (const u of pagesFromSitemap(sm.body, base)) if (allowed(u) && !next.includes(u)) next.push(u);
  }
  if (next.length < 2) for (const p of ['/contact', '/contact-us', '/contact.html', '/contactus', '/about', '/about-us', '/get-in-touch']) { const u = new URL(p, base).href; if (!next.includes(u)) next.push(u); }
  for (const url of next.slice(0, Math.max(0, maxPages - 1))) {
    if (shouldStop()) break;
    await visit(url);
  }
  return { origin, host: new URL(base).hostname.replace(/^www\./, ''), company, phone, pages, emails: [...emails].map(([email, page]) => ({ email, page })) };
}
