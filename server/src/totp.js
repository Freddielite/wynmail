import crypto from 'crypto';

// RFC 6238 time-based one-time passwords (what Google Authenticator, Authy and 1Password use). No dependencies.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const newSecret = () => {
  const bytes = crypto.randomBytes(20);
  let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
};

const decode = (s) => {
  let bits = '';
  for (const c of String(s).replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};

export const stepAt = (ms = Date.now()) => Math.floor(ms / 30000);

export function codeFor(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

// Returns the matching time step (so the caller can refuse to accept the same code twice), or null.
export function verifyCode(secret, code, { now = Date.now(), lastStep = null, window = 1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = stepAt(now);
  for (let d = -window; d <= window; d++) {
    const step = cur + d;
    if (lastStep !== null && step <= Number(lastStep)) continue;
    const want = Buffer.from(codeFor(secret, step)), got = Buffer.from(c);
    if (crypto.timingSafeEqual(want, got)) return step;
  }
  return null;
}

export const otpauthUrl = (secret, email, issuer = 'Wynmail') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// Ten single-use recovery codes, for the person who lost their phone. Only hashes are stored.
export const newRecoveryCodes = () => Array.from({ length: 10 }, () => {
  const raw = crypto.randomBytes(5).toString('hex');
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
});
export const hashRecovery = (code) => crypto.createHash('sha256').update(String(code).toLowerCase().replace(/[^a-f0-9]/g, '')).digest('hex');
