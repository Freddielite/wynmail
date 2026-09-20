import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { one } from './db.js';
import { SECRET } from './config.js';

export const hash = (pw) => bcrypt.hash(pw, 10);
export const verify = (pw, h) => bcrypt.compare(pw, h);
// Compared against when the user does not exist, so login timing does not reveal valid emails.
export const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export const sign = (user) =>
  jwt.sign({ uid: user.id, email: user.email }, SECRET, { expiresIn: '7d', algorithm: 'HS256' });

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
  // A password change or reset signs out every older session.
  const u = await one(`SELECT password_changed_at FROM users WHERE id = $1`, [req.user.uid]);
  if (!u) return res.status(401).json({ error: 'account no longer exists' });
  if (u.password_changed_at && req.user.iat < Math.floor(new Date(u.password_changed_at).getTime() / 1000)) {
    return res.status(401).json({ error: 'You were signed out because the password changed. Sign in again.' });
  }
  next();
}

export async function requireWorkspace(req, res, next) {
  const raw = req.params.workspaceId;
  if (!/^\d{1,9}$/.test(String(raw))) return res.status(400).json({ error: 'bad workspace id' });
  const row = await one(
    `SELECT w.*, m.role FROM workspaces w
     JOIN memberships m ON m.workspace_id = w.id
     WHERE w.id = $1 AND m.user_id = $2`,
    [Number(raw), req.user.uid]
  );
  if (!row) return res.status(403).json({ error: 'no access to workspace' });
  req.workspace = row;
  next();
}

// Reads the flag from the database on every request so revoking admin takes effect at once.
export async function requireAdmin(req, res, next) {
  const u = await one(`SELECT is_admin FROM users WHERE id = $1`, [req.user.uid]);
  if (!u?.is_admin) return res.status(403).json({ error: 'admin only' });
  next();
}

// Never send the provider key back to the browser.
export function publicWorkspace(w) {
  const { provider_api_key, webhook_secret, ...rest } = w;
  return { ...rest, has_provider_key: !!provider_api_key, has_webhook_secret: !!webhook_secret };
}
