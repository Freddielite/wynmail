import { Router } from 'express';
import { one, query } from '../db.js';
import { hash, verify, sign, requireAuth, publicWorkspace, DUMMY_HASH } from '../auth.js';
import { isEmail, normEmail, cleanName } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { createResetToken, consumeResetToken, resetLink } from '../resets.js';
import { sendSystemEmail, actionEmail } from '../sysmail.js';

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

const forgotIp = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const forgotEmail = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, key: (req) => `f|${normEmail(req.body?.email)}` });
const passwordLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, key: (req) => `p|${req.user?.uid}` });
const okPassword = (pw) => typeof pw === 'string' && pw.length >= 8 && pw.length <= 128;

// Same answer whether or not the account exists, and it answers before doing any work.
router.post('/forgot', forgotIp, forgotEmail, async (req, res) => {
  const email = normEmail(req.body?.email);
  res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
  if (!isEmail(email)) return;
  try {
    const user = await one(`SELECT id, email FROM users WHERE email = $1`, [email]);
    if (!user) return;
    const link = resetLink(await createResetToken(user.id, 1));
    const { html, text } = actionEmail({
      heading: 'Reset your Wynmail password',
      body: 'Someone asked to reset the password for this account. The link works once and expires in 1 hour.',
      label: 'Choose a new password', url: link,
      note: 'If this was not you, ignore this email. Your password stays the same.'
    });
    await sendSystemEmail({ to: user.email, subject: 'Reset your Wynmail password', html, text });
  } catch (err) {
    console.error('[forgot]', err.message);
  }
});

router.post('/reset', byIp, async (req, res) => {
  const { token, password } = req.body || {};
  if (!okPassword(password)) return res.status(400).json({ error: 'password must be 8 to 128 characters' });
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) {
    return res.status(400).json({ error: 'This link is invalid or has expired. Request a new one.' });
  }
  const userId = await consumeResetToken(token);
  if (!userId) return res.status(400).json({ error: 'This link is invalid or has expired. Request a new one.' });
  await query(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [userId, await hash(password)]);
  await query(`UPDATE password_resets SET used_at = COALESCE(used_at, now()) WHERE user_id = $1`, [userId]);
  res.json({ ok: true });
});

router.post('/password', requireAuth, passwordLimit, async (req, res) => {
  const { current, next } = req.body || {};
  if (!okPassword(next)) return res.status(400).json({ error: 'The new password must be 8 to 128 characters' });
  const user = await one(`SELECT * FROM users WHERE id = $1`, [req.user.uid]);
  if (!(await verify(typeof current === 'string' ? current : '', user.password_hash))) {
    return res.status(400).json({ error: 'Your current password is wrong' });
  }
  if (next === current) return res.status(400).json({ error: 'Choose a password different from the current one' });
  await query(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [user.id, await hash(next)]);
  res.json({ token: sign(user) }); // the caller stays signed in, every other session ends
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
