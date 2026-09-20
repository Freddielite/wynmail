import crypto from 'crypto';
import { one, query } from './db.js';
import { hashKey } from './apikeys.js';

export const frontendBase = () => (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/+$/, '');
export const resetLink = (token) => `${frontendBase()}/reset?token=${token}`;

// Single use tokens. Only a hash is stored.
export async function createResetToken(userId, hours = 1) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
    [userId, hashKey(token), String(hours)]
  );
  return token;
}

export async function consumeResetToken(token) {
  const row = await one(
    `UPDATE password_resets SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [hashKey(token)]
  );
  return row ? row.user_id : null;
}
