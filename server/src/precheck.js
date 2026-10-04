import { htmlToText } from './text.js';

// Looks over an email before it goes out and says what could land it in spam or confuse readers.
// level: fail (fix this), warn (worth fixing), pass, info. Pure functions, so they are easy to test.

const SPAM_PHRASES = [
  'free money', '100% free', '100% guaranteed', 'act now', 'apply now', 'as seen on', 'buy now', 'call now', 'cash bonus', 'click below',
  'click here', 'double your', 'earn $', 'earn extra', 'extra income', 'get paid', 'guarantee', 'increase sales', 'limited time', 'make money',
  'no obligation', 'no cost', 'once in a lifetime', 'order now', 'risk free', 'risk-free', 'special promotion', 'this is not spam',
  'urgent', 'what are you waiting for', 'winner', 'you have been selected', 'you are a winner', 'congratulations', 'lowest price', 'miracle', 'viagra', 'casino', 'lottery'
];
const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy'];

const item = (id, level, title, detail = '') => ({ id, level, title, detail });
const PENALTY = { fail: 20, warn: 7, info: 0, pass: 0 };

export const textOf = (html) => htmlToText(html);
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

export function extractLinks(html) {
  const out = [];
  const re = /<a\b[^>]*?href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) out.push({ href: m[1].replace(/&amp;/g, '&').trim(), text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
  return out;
}
export const extractImages = (html) => [...String(html || '').matchAll(/<img\b[^>]*>/gi)].map((m) => ({ alt: (m[0].match(/\balt\s*=\s*"([^"]*)"/i) || [])[1] }));

export const mergeFieldsUsed = (...texts) => {
  const out = new Map();
  for (const t of texts) {
    for (const m of String(t || '').matchAll(/\{\{\s*([\w.]+)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g)) {
      const key = m[1];
      if (key.toLowerCase() === 'footer') continue;
      out.set(key, out.get(key) || m[2] !== undefined);   // true when every use has a fallback
      if (m[2] === undefined) out.set(key, false);
    }
  }
  return [...out].map(([key, hasFallback]) => ({ key, hasFallback }));
};

export function analyze({ subject = '', preview = '', html = '', workspace = {}, renderedBytes = null } = {}) {
  const items = [];
  const subj = String(subject).trim();
  const text = textOf(html);
  const words = text.split(/\s+/).filter(Boolean);

  // Subject
  if (!subj) items.push(item('subject_empty', 'fail', 'The subject is empty', 'Emails without a subject are treated as junk.'));
  else {
    if (subj.length > 70) items.push(item('subject_long', 'warn', 'The subject is long', `${subj.length} characters. Phones show about 40 to 50, so the end gets cut off.`));
    const letters = subj.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 6 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6) items.push(item('subject_caps', 'warn', 'The subject is mostly capital letters', 'Shouting is a classic spam signal. Use normal sentence case.'));
    if (/[!?]{2,}/.test(subj) || (subj.match(/!/g) || []).length >= 3) items.push(item('subject_punct', 'warn', 'The subject has repeated exclamation or question marks', 'One is plenty.'));
    if (/^\s*(re|fwd?)\s*:/i.test(subj)) items.push(item('subject_fake_reply', 'warn', 'The subject starts with Re: or Fwd:', 'Pretending to be a reply is treated as deceptive.'));
    const hit = SPAM_PHRASES.filter((p) => subj.toLowerCase().includes(p));
    if (hit.length) items.push(item('subject_spam', 'warn', 'The subject uses spam trigger words', hit.slice(0, 4).join(', ')));
    if (!items.some((i) => i.id.startsWith('subject_'))) items.push(item('subject_ok', 'pass', 'The subject looks fine'));
  }

  // Content
  const imgs = extractImages(html);
  if (words.length < 3 && !imgs.length) items.push(item('body_empty', 'fail', 'The email has almost no content', 'Add some text before sending.'));
  else {
    const lower = text.toLowerCase();
    const hits = SPAM_PHRASES.filter((p) => lower.includes(p));
    if (hits.length >= 3) items.push(item('body_spam', 'warn', 'The text uses several spam trigger phrases', hits.slice(0, 6).join(', ')));
    const letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 100 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.3) items.push(item('body_caps', 'warn', 'A lot of the text is in capital letters', 'Mixed case reads better and filters better.'));
    if (imgs.length && words.length < 25) items.push(item('image_heavy', 'warn', 'The email is mostly pictures', 'Many inboxes block images by default. Add some real text so the message still makes sense.'));
    const noAlt = imgs.filter((i) => !i.alt || !i.alt.trim()).length;
    if (noAlt) items.push(item('alt_missing', 'warn', `${noAlt} picture${noAlt === 1 ? ' has' : 's have'} no description`, 'Add alt text. It shows when images are blocked and helps screen readers.'));
    if (!items.some((i) => ['body_spam', 'body_caps', 'image_heavy', 'alt_missing'].includes(i.id))) items.push(item('body_ok', 'pass', 'The content looks fine'));
  }

  // Links
  const links = extractLinks(html);
  const web = links.filter((l) => /^https?:\/\//i.test(l.href));
  const bad = links.filter((l) => /^\s*(javascript|data|vbscript):/i.test(l.href));
  if (bad.length) items.push(item('link_script', 'fail', 'A link uses a script address', 'Links that run code are blocked by every mail client and flagged as phishing.'));
  const empty = links.filter((l) => !l.href || l.href === '#');
  if (empty.length) items.push(item('link_empty', 'warn', `${empty.length} link${empty.length === 1 ? ' goes' : 's go'} nowhere`, 'The address is empty or just #.'));
  const short = web.filter((l) => SHORTENERS.includes(hostOf(l.href)));
  if (short.length) items.push(item('link_shortener', 'warn', 'The email uses link shorteners', `${[...new Set(short.map((l) => hostOf(l.href)))].join(', ')}. Spammers hide behind these, so filters distrust them. Use the full address.`));
  const plain = web.filter((l) => /^http:\/\//i.test(l.href));
  if (plain.length) items.push(item('link_http', 'warn', `${plain.length} link${plain.length === 1 ? ' is' : 's are'} not secure`, 'Use https:// addresses.'));
  const ips = web.filter((l) => /^\d{1,3}(\.\d{1,3}){3}$/.test(hostOf(l.href)));
  if (ips.length) items.push(item('link_ip', 'warn', 'A link points to a bare IP address', 'Use a proper domain name.'));
  const mismatch = web.filter((l) => {
    const shown = l.text.match(/^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/?#]\S*)?$/i);
    if (!shown) return false;
    const a = shown[1].toLowerCase().replace(/^www\./, ''), b = hostOf(l.href);
    return b && a !== b && !a.endsWith(`.${b}`) && !b.endsWith(`.${a}`);
  });
  if (mismatch.length) items.push(item('link_mismatch', 'fail', 'A link shows one address but goes to another', `For example the text says ${mismatch[0].text.slice(0, 50)} but it opens ${hostOf(mismatch[0].href)}. This looks like phishing.`));
  const vague = links.filter((l) => /^(click here|here|link|read more|more)$/i.test(l.text));
  if (vague.length) items.push(item('link_vague', 'warn', 'Some links just say "click here"', 'Describe where the link goes. It is better for readers and for filters.'));
  if (web.length > 20) items.push(item('link_many', 'warn', `The email has ${web.length} links`, 'A lot of links looks like spam. Keep to what matters.'));
  if (!items.some((i) => i.id.startsWith('link_'))) items.push(item('link_ok', 'pass', web.length ? 'The links look fine' : 'The email has no links'));

  // Merge syntax and size
  const open = (String(html).match(/\{\{/g) || []).length + (String(subject).match(/\{\{/g) || []).length;
  const close = (String(html).match(/\}\}/g) || []).length + (String(subject).match(/\}\}/g) || []).length;
  if (open !== close) items.push(item('merge_broken', 'fail', 'A merge field looks broken', 'There is a {{ without a matching }}. Contacts would see the raw code.'));
  if (renderedBytes !== null) {
    if (renderedBytes > 102400) items.push(item('size_clipped', 'fail', `The email is ${Math.round(renderedBytes / 1024)} KB`, 'Gmail cuts off emails over about 100 KB and hides the rest, including the unsubscribe link.'));
    else if (renderedBytes > 80000) items.push(item('size_large', 'warn', `The email is ${Math.round(renderedBytes / 1024)} KB`, 'Getting close to the size where Gmail cuts messages off. Trim some content.'));
  }

  // Sender setup
  if (!workspace.from_email || !workspace.sending_domain) items.push(item('sender_missing', 'fail', 'The sender is not set up', 'An admin must approve a sending domain and the from email must use it.'));
  if (!workspace.footer_address) items.push(item('footer_missing', 'fail', 'There is no postal address for the footer', 'Add one in Settings. It is required by anti-spam laws.'));
  if (workspace.from_email && workspace.footer_address && workspace.sending_domain) items.push(item('compliance_ok', 'pass', 'Unsubscribe link, postal address and a plain text version are added for you'));

  return items;
}

export function score(items) {
  const value = Math.max(0, 100 - items.reduce((n, i) => n + (PENALTY[i.level] || 0), 0));
  const fails = items.filter((i) => i.level === 'fail').length;
  return { score: value, verdict: fails ? 'risky' : value >= 85 ? 'good' : 'review', fails, warnings: items.filter((i) => i.level === 'warn').length };
}

// Items that need the database or the network.
export function domainItems(checks) {
  const out = [];
  const names = { dkim: 'DKIM signature', spf: 'SPF record', dmarc: 'DMARC policy', mx: 'Bounce address' };
  for (const c of checks || []) {
    if (!names[c.key]) continue;
    if (c.status === 'missing') out.push(item(`dns_${c.key}`, c.key === 'mx' ? 'warn' : 'fail', `${names[c.key]} is missing`, `${c.detail} Gmail and Yahoo require SPF, DKIM and DMARC for bulk senders.`));
    else if (c.status === 'warn' && c.key !== 'dmarc') out.push(item(`dns_${c.key}`, 'warn', `${names[c.key]} needs attention`, c.detail));
  }
  if (checks?.length && !out.length) out.push(item('dns_ok', 'pass', 'Domain authentication looks good', 'SPF, DKIM and DMARC are in place.'));
  return out;
}

export function reputationItems(r) {
  if (!r || r.sent < 100) return [];
  const bounce = r.bounced / r.sent, spam = r.complained / r.sent;
  const out = [];
  if (spam > 0.003) out.push(item('rep_spam', 'fail', `${(spam * 100).toFixed(2)}% of recent emails were reported as spam`, 'Above 0.3% inboxes start rejecting your mail. Clean your list and send only to people who asked.'));
  else if (spam > 0.001) out.push(item('rep_spam', 'warn', `${(spam * 100).toFixed(2)}% of recent emails were reported as spam`, 'Keep this under 0.1%.'));
  if (bounce > 0.05) out.push(item('rep_bounce', 'fail', `${(bounce * 100).toFixed(1)}% of recent emails bounced`, 'Above 5% hurts your reputation fast. Run the list health check on Contacts.'));
  else if (bounce > 0.02) out.push(item('rep_bounce', 'warn', `${(bounce * 100).toFixed(1)}% of recent emails bounced`, 'Keep this under 2%. Run the list health check on Contacts.'));
  if (!out.length) out.push(item('rep_ok', 'pass', 'Recent bounce and spam rates are healthy'));
  return out;
}

export function mergeGapItems(rows) {
  return rows.filter((r) => r.missing > 0 && !r.hasFallback).map((r) => item(`merge_gap_${r.key}`, 'warn',
    `${r.missing} of ${r.total} recipients have no ${r.key.replace(/_/g, ' ')}`,
    `They would see an empty gap. Use {{${r.key}|there}} to give it a fallback word.`));
}

export function linkItems(results) {
  const out = [];
  const dead = results.filter((r) => r.verdict === 'dead');
  const slow = results.filter((r) => r.verdict === 'slow');
  if (dead.length) out.push(item('links_dead', 'fail', `${dead.length} link${dead.length === 1 ? ' is' : 's are'} broken`, dead.slice(0, 4).map((r) => `${r.url.slice(0, 70)} (${r.reason})`).join('; ')));
  if (slow.length) out.push(item('links_slow', 'warn', `${slow.length} link${slow.length === 1 ? ' did' : 's did'} not answer in time`, slow.slice(0, 4).map((r) => r.url.slice(0, 70)).join('; ')));
  if (!out.length && results.length) out.push(item('links_live', 'pass', `All ${results.length} link${results.length === 1 ? '' : 's'} answered`));
  return out;
}

export function classifyProbe(url, r) {
  if (r.error === 'EBLOCKED' || r.error === 'EBADURL') return { url, verdict: 'dead', reason: 'not a public web address' };
  if (r.error === 'ENOTFOUND' || r.error === 'ENODATA') return { url, verdict: 'dead', reason: 'the website does not exist' };
  if (r.error) return { url, verdict: 'slow', reason: r.error.toLowerCase() };
  if (r.status === 404 || r.status === 410) return { url, verdict: 'dead', reason: `page not found (${r.status})` };
  if (r.status >= 500) return { url, verdict: 'dead', reason: `server error (${r.status})` };
  return { url, verdict: 'ok', reason: String(r.status) };   // 401, 403, 429 and redirects are fine: many sites refuse bots
}

export function uniqueWebLinks(html, max = 15) {
  return [...new Set(extractLinks(html).map((l) => l.href).filter((h) => /^https?:\/\//i.test(h) && !/\{\{/.test(h)))].slice(0, max);
}
