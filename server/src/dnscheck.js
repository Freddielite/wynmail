import dns from 'node:dns/promises';

const withTimeout = (p, ms = 4000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms))]);

// Returns records, [] when the name has none, or null when the lookup itself failed.
async function safe(fn) {
  try { return await withTimeout(fn()); } catch (e) { return ['ENODATA', 'ENOTFOUND'].includes(e.code) ? [] : null; }
}
const txt = async (r, host) => { const rows = await safe(() => r.resolveTxt(host)); return rows === null ? null : rows.map((x) => (Array.isArray(x) ? x.join('') : x)); };

const item = (key, label, host, status, detail) => ({ key, label, host, status, detail });

// status: ok, warn (works but improve), missing (fix this), unknown (could not look it up right now)
export async function checkDomain({ domain, tracking = '', resolver = dns }) {
  const out = [];
  const dkimHost = `resend._domainkey.${domain}`;
  const sendHost = `send.${domain}`;
  const dmarcHost = `_dmarc.${domain}`;
  const trackHost = tracking ? tracking.replace(/^https?:\/\//i, '').replace(/[:/].*$/, '') : '';

  // All lookups run together, so a slow name server costs one timeout, not five.
  const [dkim, sendTxt, rootTxt, mx, dmarc, cname] = await Promise.all([
    txt(resolver, dkimHost), txt(resolver, sendHost), txt(resolver, domain),
    safe(() => resolver.resolveMx(sendHost)), txt(resolver, dmarcHost),
    trackHost ? safe(() => resolver.resolveCname(trackHost)) : Promise.resolve([])
  ]);

  out.push(dkim === null ? item('dkim', 'DKIM signature', dkimHost, 'unknown', 'The lookup did not finish. Try again in a moment.')
    : dkim.some((r) => /\bp=/.test(r)) ? item('dkim', 'DKIM signature', dkimHost, 'ok', 'Found. Your emails are signed.')
    : item('dkim', 'DKIM signature', dkimHost, 'missing', 'Not found. Copy the DKIM record shown in your Resend domain page into your DNS.'));

  const spfAt = (rows) => (rows || []).filter((r) => /^v=spf1/i.test(r));
  if (sendTxt === null && rootTxt === null) out.push(item('spf', 'SPF record', sendHost, 'unknown', 'The lookup did not finish. Try again in a moment.'));
  else if (spfAt(sendTxt).length) out.push(item('spf', 'SPF record', sendHost, 'ok', 'Found on the sending subdomain.'));
  else if (spfAt(rootTxt).length > 1) out.push(item('spf', 'SPF record', domain, 'warn', 'You have more than one SPF record. Merge them into one, or receivers will ignore both.'));
  else if (spfAt(rootTxt).length === 1) out.push(item('spf', 'SPF record', domain, 'ok', 'Found on your main domain.'));
  else out.push(item('spf', 'SPF record', sendHost, 'missing', 'Not found. Add the SPF record from your Resend domain page.'));

  out.push(mx === null ? item('mx', 'Bounce address (MX)', sendHost, 'unknown', 'The lookup did not finish. Try again in a moment.')
    : mx.length ? item('mx', 'Bounce address (MX)', sendHost, 'ok', 'Found. Bounces can be reported back.')
    : item('mx', 'Bounce address (MX)', sendHost, 'warn', 'Not found. Add the MX record from your Resend domain page so bounces are reported.'));

  const rec = (dmarc || []).find((r) => /^v=DMARC1/i.test(r));
  if (dmarc === null) out.push(item('dmarc', 'DMARC policy', dmarcHost, 'unknown', 'The lookup did not finish. Try again in a moment.'));
  else if (!rec) out.push(item('dmarc', 'DMARC policy', dmarcHost, 'missing', 'Not found. Add a TXT record with the value v=DMARC1; p=none; rua=mailto:you@yourdomain.'));
  else {
    const policy = (rec.match(/\bp=(\w+)/i) || [])[1]?.toLowerCase();
    out.push(policy === 'none'
      ? item('dmarc', 'DMARC policy', dmarcHost, 'warn', 'Found, set to monitor only. That is a fine start. Move to quarantine once your reports look clean.')
      : item('dmarc', 'DMARC policy', dmarcHost, 'ok', `Found, policy ${policy || 'set'}.`));
  }

  if (trackHost) {
    const a = cname && cname.length ? cname : cname === null ? null : await safe(() => resolver.resolve4(trackHost));
    out.push(a === null ? item('tracking', 'Tracking domain', trackHost, 'unknown', 'The lookup did not finish. Try again in a moment.')
      : a.length ? item('tracking', 'Tracking domain', trackHost, 'ok', 'Points somewhere. Make sure it points at your Wynmail server.')
      : item('tracking', 'Tracking domain', trackHost, 'missing', 'Not found. Add a CNAME record for this name pointing at your Wynmail server host.'));
  }
  return out;
}
