import { Router } from 'express';
import { many, one, query } from '../db.js';
import { hash, requireAuth, requireAdmin, publicWorkspace } from '../auth.js';
import { isEmail, normEmail, DOMAIN_RE, cleanName } from '../validate.js';

const router = Router();
router.use(requireAuth, requireAdmin);
const bad = (res, msg) => res.status(400).json({ error: msg });

router.get('/workspaces', async (_req, res) => {
  res.json(await many(
    `SELECT w.id, w.name, w.sending_domain, w.from_email, w.daily_limit, w.rate_per_minute, w.provider,
       (w.provider_api_key IS NOT NULL AND w.provider_api_key <> '') AS has_provider_key,
       (SELECT count(*)::int FROM contacts c WHERE c.workspace_id = w.id) AS contacts,
       (SELECT count(*)::int FROM messages m WHERE m.workspace_id = w.id AND m.sent_at >= date_trunc('day', now())) AS sent_today,
       (SELECT string_agg(u.email, ', ') FROM memberships ms JOIN users u ON u.id = ms.user_id WHERE ms.workspace_id = w.id) AS members
     FROM workspaces w ORDER BY w.id`
  ));
});

// Creates a client workspace, its owner login, and adds the admin as a member so they can switch into it.
router.post('/workspaces', async (req, res) => {
  const name = cleanName(req.body?.name);
  const ownerEmail = normEmail(req.body?.owner_email);
  const password = req.body?.password;
  const domain = String(req.body?.sending_domain ?? '').trim().toLowerCase();
  if (!name) return bad(res, 'name required');
  if (!isEmail(ownerEmail)) return bad(res, 'valid owner email required');
  if (domain && !DOMAIN_RE.test(domain)) return bad(res, 'invalid sending domain');

  let owner = await one(`SELECT id FROM users WHERE email = $1`, [ownerEmail]);
  if (!owner) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return bad(res, 'set a password of 8 to 128 characters for the new owner');
    }
    owner = await one(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`, [ownerEmail, await hash(password)]);
  }
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'client'}-${Date.now().toString(36)}`;
  const workspace = await one(
    `INSERT INTO workspaces (name, slug, from_name, sending_domain) VALUES ($1, $2, $1, $3) RETURNING *`,
    [name, slug, domain || null]
  );
  await query(`INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [owner.id, workspace.id]);
  await query(`INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`, [req.user.uid, workspace.id]);
  res.json(publicWorkspace(workspace));
});

router.put('/workspaces/:id', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return bad(res, 'bad id');
  const f = req.body || {};
  const v = {};
  if (f.sending_domain !== undefined) {
    const d = String(f.sending_domain ?? '').trim().toLowerCase();
    if (d && !DOMAIN_RE.test(d)) return bad(res, 'invalid sending domain');
    v.sending_domain = d;
  }
  if (f.rate_per_minute !== undefined) {
    const n = Number(f.rate_per_minute);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return bad(res, 'emails per minute must be 1 to 1000');
    v.rate_per_minute = n;
  }
  if (f.daily_limit !== undefined) {
    const n = Number(f.daily_limit);
    if (!Number.isInteger(n) || n < 0 || n > 100000) return bad(res, 'daily limit must be 0 to 100000');
    v.daily_limit = n;
  }
  if (f.provider !== undefined) {
    if (!['resend', 'console'].includes(f.provider)) return bad(res, 'unknown provider');
    v.provider = f.provider;
  }
  const row = await one(
    `UPDATE workspaces SET sending_domain = COALESCE($2, sending_domain), rate_per_minute = COALESCE($3, rate_per_minute),
       daily_limit = COALESCE($4, daily_limit), provider = COALESCE($5, provider) WHERE id = $1 RETURNING *`,
    [req.params.id, v.sending_domain, v.rate_per_minute, v.daily_limit, v.provider]
  );
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(publicWorkspace(row));
});

export default router;
