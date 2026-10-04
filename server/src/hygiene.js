import dns from 'node:dns/promises';

// Throwaway inboxes. People use these to get past a signup, and they never read what you send.
export const DISPOSABLE = new Set((
  '10minutemail.com 10minutemail.net 20minutemail.com 33mail.com anonbox.net binkmail.com bobmail.info burnermail.io ' +
  'crazymailing.com dayrep.com deadaddress.com discard.email discardmail.com disposablemail.com dispostable.com ' +
  'dropmail.me emailondeck.com fakeinbox.com fakemail.net filzmail.com getairmail.com getnada.com guerrillamail.biz ' +
  'guerrillamail.com guerrillamail.de guerrillamail.net guerrillamail.org guerrillamailblock.com harakirimail.com ' +
  'inboxbear.com incognitomail.com instantemailaddress.com jetable.org kasmail.com mail-temporaire.fr mailcatch.com ' +
  'maildrop.cc mailforspam.com mailinator.com mailinator.net mailnesia.com mailnull.com mailsac.com mailtemp.info ' +
  'mintemail.com moakt.com mohmal.com mt2015.com mytemp.email mytrashmail.com nada.email nowmymail.com owlymail.com ' +
  'sharklasers.com spam4.me spambog.com spambox.us spamgourmet.com spamherelots.com spamhole.com spaml.com ' +
  'temp-mail.io temp-mail.org tempail.com tempemail.net tempinbox.com tempmail.com tempmail.net tempmail.plus ' +
  'tempmailo.com tempr.email throwaway.email throwawaymail.com tmail.ws tmpmail.net tmpmail.org trash-mail.com ' +
  'trashmail.com trashmail.de trashmail.net trashmail.org trbvm.com wegwerfmail.de yopmail.com yopmail.fr yopmail.net ' +
  'zetmail.com tmails.net emailfake.com fakemailgenerator.com mail.tm mailpoof.com emltmp.com internxt.com'
).split(/\s+/).filter(Boolean));

// Shared inboxes. Fine for some businesses, risky for marketing: nobody owns them, and complaints are common.
export const ROLE_LOCALS = new Set((
  'abuse admin administrator billing careers contact enquiries enquiry help hostmaster info jobs mail marketing ' +
  'noreply no-reply donotreply do-not-reply office postmaster press root sales security spam support team webmaster'
).split(/\s+/).filter(Boolean));

// Unmistakable typos of the big mailbox providers. These are suggestions, never silent fixes.
const TYPOS = {
  'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmaill.com': 'gmail.com',
  'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.comm': 'gmail.com', 'gmai.com': 'gmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'yahoo.cm': 'yahoo.com',
  'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'hotmal.com': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outlook.con': 'outlook.com', 'iclould.com': 'icloud.com', 'icloud.con': 'icloud.com'
};

// RFC 6761 names that can never receive real mail. Rejected without a lookup.
const RESERVED_TLDS = ['invalid', 'test', 'localhost', 'example', 'local'];

const split = (email) => { const i = String(email).lastIndexOf('@'); return [String(email).slice(0, i).toLowerCase(), String(email).slice(i + 1).toLowerCase()]; };

export const isRole = (email) => ROLE_LOCALS.has(split(email)[0].split('+')[0]);
export const isDisposable = (domain) => {
  const parts = String(domain).toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i += 1) if (DISPOSABLE.has(parts.slice(i).join('.'))) return true;
  return false;
};
export const typoFor = (email) => { const [local, domain] = split(email); return TYPOS[domain] ? `${local}@${TYPOS[domain]}` : null; };
export const isReservedDomain = (domain) => RESERVED_TLDS.includes(String(domain).toLowerCase().split('.').pop());

// DNS lookups are slow and flaky, so answers are remembered. Only definite answers are trusted for long.
const cache = new Map();
const remember = (domain, value, ms) => { if (cache.size > 5000) cache.clear(); cache.set(domain, { value, until: Date.now() + ms }); return value; };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms))]);
const NO_ANSWER = ['ENODATA', 'ENOTFOUND', 'NXDOMAIN'];

// 'ok' it can receive mail, 'none' it definitely cannot, 'unknown' the lookup failed (never blocks anyone).
export async function mxStatus(domain, resolver = dns, { timeout = 3000, useCache = true } = {}) {
  if (isReservedDomain(domain)) return 'none';
  const hit = useCache && cache.get(domain);
  if (hit && hit.until > Date.now()) return hit.value;
  try {
    const mx = await withTimeout(resolver.resolveMx(domain), timeout);
    if (mx.length && mx.every((m) => !m.exchange || m.exchange === '.')) return remember(domain, 'none', 6 * 3600e3); // null MX, RFC 7505
    if (mx.length) return remember(domain, 'ok', 6 * 3600e3);
  } catch (e) {
    if (!NO_ANSWER.includes(e.code)) return remember(domain, 'unknown', 5 * 60e3);
  }
  // No MX record: mail servers fall back to the address record of the domain itself.
  try {
    const a = await withTimeout(resolver.resolve4(domain), timeout);
    return remember(domain, a.length ? 'ok' : 'none', 6 * 3600e3);
  } catch (e) {
    return NO_ANSWER.includes(e.code) ? remember(domain, 'none', 6 * 3600e3) : remember(domain, 'unknown', 5 * 60e3);
  }
}
export const clearMxCache = () => cache.clear();

// Dry runs (FORCE_PROVIDER=console) never touch DNS unless MX_CHECK=on. MX_CHECK=off always skips it.
export const mxEnabled = () => process.env.MX_CHECK === 'on' || (process.env.MX_CHECK !== 'off' && process.env.FORCE_PROVIDER !== 'console');

// policy: { block_disposable, block_role, check_mx } straight from the workspace row.
export async function assessEmail(email, policy = {}, { resolver, checkMx = mxEnabled() } = {}) {
  const [local, domain] = split(email);
  const suggestion = typoFor(email);
  if (suggestion) return { ok: false, code: 'typo', suggestion, message: `Did you mean ${suggestion}?` };
  if (policy.block_disposable !== false && isDisposable(domain)) return { ok: false, code: 'disposable', message: 'Disposable email addresses are not accepted. Please use your real address.' };
  if (policy.block_role && isRole(email)) return { ok: false, code: 'role', message: `Shared addresses like ${local.split('+')[0]}@ are not accepted. Please use a personal address.` };
  if (isReservedDomain(domain)) return { ok: false, code: 'no_mx', message: `${domain} cannot receive email. Check the spelling.` };
  if (policy.check_mx !== false && checkMx && (await mxStatus(domain, resolver)) === 'none') return { ok: false, code: 'no_mx', message: `${domain} cannot receive email. Check the spelling.` };
  return { ok: true, role: isRole(email) };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next; next += 1; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// Checks many addresses at once. Each domain is looked up once, however many addresses share it.
export async function assessMany(emails, policy, { resolver, checkMx = mxEnabled(), concurrency = 15 } = {}) {
  // Addresses already refused by a cheaper rule never cost a lookup.
  const cheap = (email) => {
    const [, domain] = split(email);
    return typoFor(email) || (policy.block_disposable !== false && isDisposable(domain)) || (policy.block_role && isRole(email)) || isReservedDomain(domain);
  };
  const domains = [...new Set(emails.filter((e) => !cheap(e)).map((e) => split(e)[1]))];
  const status = new Map();
  if (policy.check_mx !== false && checkMx) {
    await pool(domains, concurrency, async (d) => { status.set(d, await mxStatus(d, resolver)); });
  }
  return emails.map((email) => {
    const [local, domain] = split(email);
    const suggestion = typoFor(email);
    if (suggestion) return { ok: false, code: 'typo', message: `looks like a typo, did you mean ${suggestion}?` };
    if (policy.block_disposable !== false && isDisposable(domain)) return { ok: false, code: 'disposable', message: 'disposable address' };
    if (policy.block_role && isRole(email)) return { ok: false, code: 'role', message: `shared address (${local.split('+')[0]}@)` };
    if (isReservedDomain(domain) || status.get(domain) === 'none') return { ok: false, code: 'no_mx', message: `${domain} cannot receive email` };
    return { ok: true };
  });
}

// Looks over every subscribed contact and groups the ones that will hurt your reputation.
export async function groupProblems(rows, { resolver, checkMx = mxEnabled(), maxDomains = 400 } = {}) {
  const groups = { disposable: [], typo: [], no_mx: [], role: [] };
  const clean = [];
  for (const r of rows) {
    const [, domain] = split(r.email);
    if (typoFor(r.email)) groups.typo.push(r);
    else if (isDisposable(domain)) groups.disposable.push(r);
    else if (isReservedDomain(domain)) groups.no_mx.push(r);
    else { clean.push(r); if (isRole(r.email)) groups.role.push(r); }
  }
  const domains = [...new Set(clean.map((r) => split(r.email)[1]))];
  const checked = checkMx ? domains.slice(0, maxDomains) : [];
  const status = new Map();
  await pool(checked, 15, async (d) => { status.set(d, await mxStatus(d, resolver)); });
  for (const r of clean) if (status.get(split(r.email)[1]) === 'none') groups.no_mx.push(r);
  return { groups, domains: domains.length, checked: checked.length, truncated: checkMx && domains.length > checked.length };
}
