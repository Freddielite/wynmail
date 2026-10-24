import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { one } from './db.js';
import { SECRET } from './config.js';

export const hash = (pw) => bcrypt.hash(pw, 10);
export const verify = (pw, h) => bcrypt.compare(pw, h);
// Compared against when the user does not exist, so login timing does not reveal valid emails.
export const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// Sessions end on their own after SESSION_HOURS (default 7 days), and can be ended early for one user.
export const sign = (user) =>
  jwt.sign({ uid: user.id, email: user.email }, SECRET, { expiresIn: `${Number(process.env.SESSION_HOURS) || 168}h`, algorithm: 'HS256' });

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
  // A password change, a reset, or "sign out everywhere" ends every older session.
  const u = await one(`SELECT password_changed_at, sessions_valid_after FROM users WHERE id = $1`, [req.user.uid]);
  if (!u) return res.status(401).json({ error: 'account no longer exists' });
  const cutoff = Math.max(...[u.password_changed_at, u.sessions_valid_after].filter(Boolean).map((d) => Math.floor(new Date(d).getTime() / 1000)), 0);
  if (cutoff && req.user.iat < cutoff) {
    return res.status(401).json({ error: 'You were signed out. Sign in again.' });
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
