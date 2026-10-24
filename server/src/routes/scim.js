import express, { Router } from 'express';
import { many, one, query } from '../db.js';
import { hashKey } from '../apikeys.js';
import { hash } from '../auth.js';
import { rateLimit } from '../rateLimit.js';
import { audit } from '../audit.js';
import { isEmail, normEmail, cleanName } from '../validate.js';
import { domainOf, randomPassword } from '../sso.js';

// SCIM 2.0 (RFC 7644), the part identity providers use to add and remove people. When IT offboards someone,
// their membership is deleted here, and the next request they make to the workspace is refused.
const router = Router();
const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCHEMA_ERR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const MANAGED = `('member', 'viewer')`; // owners and platform admins are never touched by SCIM

const send = (res, status, body) => res.status(status).type('application/scim+json').send(JSON.stringify(body));
const fail = (res, status, detail, scimType) => send(res, status, { schemas: [SCHEMA_ERR], status: String(status), detail, ...(scimType ? { scimType } : {}) });

router.use(express.json({ type: ['application/json', 'application/scim+json'], limit: '500kb' }));

async function requireToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const row = token ? await one(`SELECT workspace_id, id FROM scim_tokens WHERE token_hash = $1 AND revoked_at IS NULL`, [hashKey(token)]) : null;
  if (!row) return fail(res, 401, 'Invalid or revoked token');
  const cfg = await one(`SELECT domains FROM sso_configs WHERE workspace_id = $1`, [row.workspace_id]);
  req.wid = row.workspace_id;
  req.domains = cfg?.domains || [];
  req.user = { uid: null };
  req.workspace = { id: row.workspace_id };
  next();
}
router.use(rateLimit({ windowMs: 60000, max: 600, key: (req) => `scim|${hashKey(req.headers.authorization || '').slice(0, 16)}` }));
router.use(requireToken);

const shape = (u, m) => ({
  schemas: [SCHEMA_USER], id: String(u.id), externalId: m?.scim_external_id || undefined, userName: u.email,
  name: { formatted: u.name || undefined }, emails: [{ value: u.email, primary: true }], active: !!m,
  meta: { resourceType: 'User' }
});
const USER_Q = `SELECT u.id, u.email, u.name, m.user_id IS NOT NULL AS member, m.scim_external_id
  FROM users u LEFT JOIN memberships m ON m.user_id = u.id AND m.workspace_id = $1`;
const asView = (r) => shape(r, r.member ? { scim_external_id: r.scim_external_id } : null);

router.get('/ServiceProviderConfig', (_req, res) => send(res, 200, {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
  authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Token created by Wyntek for this workspace' }]
}));
router.get('/ResourceTypes', (_req, res) => send(res, 200, [{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: SCHEMA_USER }]));

router.get('/Users', async (req, res) => {
  const count = Math.min(Math.max(Number(req.query.count) || 100, 1), 200);
  const start = Math.max(Number(req.query.startIndex) || 1, 1);
  const params = [req.wid];
  let where = `m.user_id IS NOT NULL AND m.role IN ${MANAGED}`;
  const f = String(req.query.filter || '').match(/^userName\s+eq\s+"([^"]{1,254})"$/i);
  if (req.query.filter && !f) return fail(res, 400, 'Only: userName eq "value"', 'invalidFilter');
  if (f) { params.push(normEmail(f[1])); where = `u.email = $2`; }
  const rows = await many(`${USER_Q} WHERE ${where} ORDER BY u.id LIMIT ${count} OFFSET ${start - 1}`, params);
  send(res, 200, { schemas: [SCHEMA_LIST], totalResults: rows.length + start - 1, startIndex: start, itemsPerPage: rows.length, Resources: rows.map(asView) });
});

const find = async (req) => /^\d{1,9}$/.test(req.params.id) ? one(`${USER_Q} WHERE u.id = $2`, [req.wid, Number(req.params.id)]) : null;

router.get('/Users/:id', async (req, res) => {
  const u = await find(req);
  return u ? send(res, 200, asView(u)) : fail(res, 404, 'User not found');
});

const emailOf = (b) => normEmail(b.userName || (b.emails || []).find((e) => e.primary)?.value || b.emails?.[0]?.value);
const nameOf = (b) => cleanName([b.name?.givenName, b.name?.familyName].filter(Boolean).join(' ') || b.name?.formatted || b.displayName) || null;

async function addMember(wid, userId, externalId) {
  await query(`INSERT INTO memberships (user_id, workspace_id, role, provisioned_by, scim_external_id) VALUES ($1, $2, 'member', 'scim', $3)
    ON CONFLICT (user_id, workspace_id) DO UPDATE SET scim_external_id = COALESCE(EXCLUDED.scim_external_id, memberships.scim_external_id)`, [userId, wid, externalId || null]);
}
async function removeMember(wid, userId) {
  return one(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2 AND role IN ${MANAGED} RETURNING user_id`, [wid, userId]);
}

router.post('/Users', async (req, res) => {
  const b = req.body || {};
  const email = emailOf(b);
  if (!isEmail(email)) return fail(res, 400, 'userName must be an email address', 'invalidValue');
  if (!req.domains.includes(domainOf(email))) return fail(res, 400, 'That email is not at one of this workspace\'s SSO domains', 'invalidValue');
  let u = await one(`SELECT id, email, name FROM users WHERE email = $1`, [email]);
  if (u && await one(`SELECT 1 FROM memberships WHERE user_id = $1 AND workspace_id = $2`, [u.id, req.wid])) return fail(res, 409, 'User already exists', 'uniqueness');
  if (!u) u = await one(`INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name`, [email, await hash(randomPassword()), nameOf(b)]);
  if (b.active !== false) await addMember(req.wid, u.id, b.externalId);
  await audit(req, 'scim.user_created', { workspaceId: req.wid, actorId: null, target: u.id });
  send(res, 201, shape(u, b.active === false ? null : { scim_external_id: b.externalId }));
});

// Sets a person active or not. Not active means no membership, so access ends on their very next request.
async function setActive(req, u, active) {
  if (active && !u.member) { await addMember(req.wid, u.id, null); await audit(req, 'scim.user_activated', { workspaceId: req.wid, actorId: null, target: u.id }); }
  if (!active && u.member) {
    const gone = await removeMember(req.wid, u.id);
    if (gone) await audit(req, 'scim.user_deactivated', { workspaceId: req.wid, actorId: null, target: u.id });
  }
}
const truthy = (v) => v === true || String(v).toLowerCase() === 'true';

router.put('/Users/:id', async (req, res) => {
  const u = await find(req);
  if (!u) return fail(res, 404, 'User not found');
  const b = req.body || {};
  const name = nameOf(b);
  if (name) await query(`UPDATE users SET name = $2 WHERE id = $1`, [u.id, name]);
  if (b.active !== undefined) await setActive(req, u, truthy(b.active));
  send(res, 200, asView(await find(req)));
});

router.patch('/Users/:id', async (req, res) => {
  const u = await find(req);
  if (!u) return fail(res, 404, 'User not found');
  for (const op of Array.isArray(req.body?.Operations) ? req.body.Operations : []) {
    const kind = String(op.op || '').toLowerCase();
    if (!['replace', 'add'].includes(kind)) continue;
    // Azure sends {path:"active", value:"False"}; Okta sends {value:{active:false}}.
    const value = op.path ? { [op.path]: op.value } : (op.value || {});
    if (value.active !== undefined) await setActive(req, (await find(req)) || u, truthy(value.active));
    const nm = value['name.givenName'] !== undefined || value.name ? nameOf({ name: value.name || { givenName: value['name.givenName'], familyName: value['name.familyName'] } }) : null;
    if (nm) await query(`UPDATE users SET name = $2 WHERE id = $1`, [u.id, nm]);
  }
  send(res, 200, asView(await find(req)));
});

router.delete('/Users/:id', async (req, res) => {
  const u = await find(req);
  if (!u) return fail(res, 404, 'User not found');
  await setActive(req, u, false);
  res.status(204).end();
});

router.use((_req, res) => fail(res, 404, 'Unknown endpoint'));
export default router;
