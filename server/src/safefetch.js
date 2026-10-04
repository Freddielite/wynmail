import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

// The link check fetches addresses typed by users, so it must never reach into our own network.
export function isPrivateIp(ip) {
  const s = String(ip).toLowerCase();
  if (net.isIPv4(s)) {
    const [a, b] = s.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(s)) {
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
  }
  return true;
}

// Every connection resolves the name itself and refuses private answers, so DNS tricks cannot slip past a pre-check.
const guardedLookup = (hostname, options, cb) => {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    return options?.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
  });
};

function once(url, method, { timeout, allowPrivate }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method, timeout, headers: { 'User-Agent': 'WynmailLinkCheck/1.0', Accept: '*/*' },
      ...(allowPrivate ? {} : { lookup: guardedLookup }), agent: false
    }, (res) => { res.destroy(); resolve({ status: res.statusCode }); });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end();
  });
}

// Never follows redirects (a 3xx counts as alive), only http and https, only the standard ports.
export async function probe(url, { timeout = 4000, allowPrivate = false } = {}) {
  let u;
  try { u = new URL(url); } catch { return { error: 'EBADURL' }; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return { error: 'EBLOCKED' };
  if (!allowPrivate && u.port && !['80', '443'].includes(u.port)) return { error: 'EBLOCKED' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && net.isIP(host) && isPrivateIp(host)) return { error: 'EBLOCKED' };
  let r = await once(u.href, 'HEAD', { timeout, allowPrivate });
  if (r.status && [400, 403, 405, 501].includes(r.status)) r = await once(u.href, 'GET', { timeout, allowPrivate });
  return r;
}
