import crypto from 'crypto';

export const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

// Keys are 192 random bits, so a fast hash is enough. Only the hash is stored.
export function newKey() {
  const key = 'wm_' + crypto.randomBytes(24).toString('base64url');
  return { key, prefix: key.slice(0, 10), hash: hashKey(key) };
}
