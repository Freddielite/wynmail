import { Router } from 'express';
import crypto from 'crypto';
import { many, one, query } from '../db.js';
import { audit } from '../audit.js';
import { hashKey } from '../apikeys.js';
import { acsUrl, spEntityId } from '../sso.js';
import { DOMAIN_RE } from '../validate.js';

// SSO and SCIM setup. Reading is for the owner. Changing it is for Wyntek admins only: the domain list decides whose
// emails a company's identity provider may sign in as, so it must not be editable by the customer.
const router = Router({ mergeParams: true });
const ws = (req) => req.workspace.id;
const bad = (res, msg) => res.status(400).json({ error: msg });
const platformAdmin = async (req, res, next) =>
  (await one(`SELECT is_admin FROM users WHERE id = $1`, [req.user.uid]))?.is_admin ? next() : res.status(403).json({ error: 'Ask Wyntek to change single sign-on settings' });

const view = (w, cfg) => ({
  enabled: false, idp_entity_id: '', idp_sso_url: '', has_cert: false, domains: [], enforce: false, default_role: 'member', ...(cfg ? { ...cfg, has_cert: !!cfg.idp_cert, idp_cert: undefined } : {}),
  sp_entity_id: spEntityId(w), acs_url: acsUrl(w), metadata_url: spEntityId(w),
  scim_base_url: `${(process.env.PUBLIC_URL || '').replace(/\/+$/, '')}/scim/v2`
});

router.get('/sso', async (req, res) => res.json(view(ws(req), await one(`SELECT * FROM sso_configs WHERE workspace_id = $1`, [ws(req)]))));

router.put('/sso', platformAdmin, async (req, res) => {
  const b = req.body || {};
  const domains = Array.isArray(b.domains) ? [...new Set(b.domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean))].slice(0, 10) : null;
  if (domains && !domains.every((d) => DOMAIN_RE.test(d))) return bad(res, 'domains must look like acme.com');
  if (b.idp_sso_url !== undefined && b.idp_sso_url !== '' && !/^https:\/\/[^\s]+$/.test(b.idp_sso_url)) return bad(res, 'The sign-in URL must start with https://');
  const cert = typeof b.idp_cert === 'string' ? b.idp_cert.trim() : null;
  if (cert && !/BEGIN CERTIFICATE/.test(cert) && !/^[A-Za-z0-9+/=\s]{200,}$/.test(cert)) return bad(res, 'Paste the identity provider certificate (PEM)');
  if (b.default_role !== undefined && !['member', 'viewer'].includes(b.default_role)) return bad(res, 'default role must be member or viewer');
  if (domains?.length) {
    const taken = await one(`SELECT workspace_id FROM sso_configs WHERE workspace_id <> $1 AND domains && $2::text[]`, [ws(req), domains]);
    if (taken) return bad(res, 'Another workspace already uses one of those domains');
  }
  await query(`INSERT INTO sso_configs (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ws(req)]);
  const row = await one(
    `UPDATE sso_configs SET idp_entity_id = COALESCE($2, idp_entity_id), idp_sso_url = COALESCE($3, idp_sso_url), idp_cert = COALESCE($4, idp_cert),
       domains = COALESCE($5::text[], domains), enforce = COALESCE($6::boolean, enforce), enabled = COALESCE($7::boolean, enabled),
       default_role = COALESCE($8, default_role), updated_at = now() WHERE workspace_id = $1 RETURNING *`,
    [ws(req), b.idp_entity_id ?? null, b.idp_sso_url ?? null, cert || null, domains, typeof b.enforce === 'boolean' ? b.enforce : null,
     typeof b.enabled === 'boolean' ? b.enabled : null, b.default_role ?? null]);
  if (row.enabled && (!row.idp_sso_url || !row.idp_cert || !row.domains.length)) {
    await query(`UPDATE sso_configs SET enabled = false, enforce = false WHERE workspace_id = $1`, [ws(req)]);
    return bad(res, 'Add the sign-in URL, certificate and at least one domain before turning SSO on');
  }
  await audit(req, 'sso.config_changed', { meta: { fields: Object.keys(b), enabled: row.enabled, enforce: row.enforce } });
  res.json(view(ws(req), row));
});

/* ---------- SCIM tokens: what the identity provider uses to add and remove people ---------- */
router.get('/scim-tokens', async (req, res) => res.json(await many(
  `SELECT id, prefix, created_at FROM scim_tokens WHERE workspace_id = $1 AND revoked_at IS NULL ORDER BY id DESC`, [ws(req)])));

router.post('/scim-tokens', platformAdmin, async (req, res) => {
  const token = 'wmscim_' + crypto.randomBytes(24).toString('base64url');
  const row = await one(`INSERT INTO scim_tokens (workspace_id, prefix, token_hash) VALUES ($1, $2, $3) RETURNING id, prefix, created_at`,
    [ws(req), token.slice(0, 12), hashKey(token)]);
  await audit(req, 'scim.token_created', { target: row.id });
  res.json({ ...row, token }); // shown once
});

router.delete('/scim-tokens/:id', platformAdmin, async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return bad(res, 'bad id');
  await query(`UPDATE scim_tokens SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`, [req.params.id, ws(req)]);
  await audit(req, 'scim.token_revoked', { target: req.params.id });
  res.json({ ok: true });
});

export default router;
