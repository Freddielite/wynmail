import { Router } from 'express';
import { one, query } from '../db.js';
import { hash, verify, sign, requireAuth, publicWorkspace, DUMMY_HASH } from '../auth.js';
import { isEmail, normEmail, cleanName } from '../validate.js';
import { rateLimit } from '../rateLimit.js';

const router = Router();
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
const byIp = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const byAccount = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, key: (req) => `${req.ip}|${normEmail(req.body?.email)}` });

router.post('/register', byIp, async (req, res) => {
  const { password, name, workspaceName } = req.body || {};
  const email = normEmail(req.body?.email);
  const { n } = await one(`SELECT count(*)::int AS n FROM users`);

  if (n > 0 && process.env.ALLOW_SIGNUP !== 'true') {
    return res.status(403).json({ error: 'Sign up is closed. Ask Wyntek to create your workspace.' });
  }
  const adminEmail = normEmail(process.env.ADMIN_EMAIL);
  if (n === 0 && adminEmail && email !== adminEmail) {
    return res.status(403).json({ error: 'The first account must use the configured admin email.' });
  }
  if (!isEmail(email)) return res.status(400).json({ error: 'enter a valid email' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'password must be 8 to 128 characters' });
  }
  if (await one(`SELECT 1 FROM users WHERE email = $1`, [email])) {
    return res.status(409).json({ error: 'email already registered' });
  }

  // The first account ever created becomes the admin.
  const user = await one(
    `INSERT INTO users (email, password_hash, name, is_admin)
     VALUES ($1, $2, $3, NOT EXISTS (SELECT 1 FROM users)) RETURNING *`,
    [email, await hash(password), cleanName(name) || null]
  );
  const wsName = cleanName(workspaceName) || `${cleanName(name) || email.split('@')[0]}'s workspace`;
  const workspace = await one(
    `INSERT INTO workspaces (name, slug, from_name) VALUES ($1, $2, $1) RETURNING *`,
    [wsName, `${slugify(wsName)}-${user.id}`]
  );
  await query(`INSERT INTO memberships (user_id, workspace_id) VALUES ($1, $2)`, [user.id, workspace.id]);

  res.json({ token: sign(user), user: { id: user.id, email: user.email, name: user.name }, workspace: publicWorkspace(workspace) });
});

router.post('/login', byIp, byAccount, async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = await one(`SELECT * FROM users WHERE email = $1`, [email]);
  const ok = await verify(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'invalid credentials' });
  res.json({ token: sign(user), user: { id: user.id, email: user.email, name: user.name } });
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await one(`SELECT id, email, name, is_admin FROM users WHERE id = $1`, [req.user.uid]);
  if (!user) return res.status(401).json({ error: 'account no longer exists' });
  const rows = (await query(
    `SELECT w.* FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = $1 ORDER BY w.id`,
    [req.user.uid]
  )).rows;
  res.json({ user, workspaces: rows.map(publicWorkspace) });
});

export default router;
