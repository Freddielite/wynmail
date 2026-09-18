import crypto from 'crypto';

const prod = process.env.NODE_ENV === 'production';
let secret = process.env.JWT_SECRET;

if (!secret) {
  if (prod) throw new Error('JWT_SECRET is required in production');
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('[security] JWT_SECRET not set. Using a random secret for this run only.');
} else if (prod && secret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}

export const SECRET = secret;
const encKey = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY || secret).digest();

export const hmac = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// AES-256-GCM. Used for provider API keys at rest.
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decrypt(payload) {
  if (!payload) return null;
  if (!payload.startsWith('v1:')) return payload; // legacy plaintext value
  const buf = Buffer.from(payload.slice(3), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
