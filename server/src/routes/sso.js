import express, { Router } from 'express';
import { one, query } from '../db.js';
import { sign, hash } from '../auth.js';
import { rateLimit } from '../rateLimit.js';
import { audit } from '../audit.js';
import { frontendBase } from '../resets.js';
import { samlFor, ssoConfigForEmail, emailFromProfile, domainOf, randomPassword } from '../sso.js';
import { isEmail, normEmail } from '../validate.js';

const router = Router();
const limit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
const back = (res, error) => res.redirect(`${frontendBase()}/login?sso_error=${encodeURIComponent(error)}`);

// SP metadata the customer's IT team pastes into their identity provider.
router.get('/:workspaceId/metadata', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.workspaceId)) return res.status(404).end();
  const cfg = await one(`SELECT * FROM sso_configs WHERE workspace_id = $1`, [Number(req.params.workspaceId)]);
  if (!cfg) return res.status(404).end();
  res.type('application/xml').send(samlFor(Number(req.params.workspaceId), { ...cfg, idp_cert: cfg.idp_cert || 'x' }).generateServiceProviderMetadata(null, null));
});

// Step 1: the person types their work email, we send them to their company's sign-in page.
router.get('/start', limit, async (req, res) => {
  const email = normEmail(req.query.email);
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter your work email' });
  const cfg = await ssoConfigForEmail(email);
  if (!cfg) return res.status(404).json({ error: 'Single sign-on is not set up for that email domain.' });
  const url = await samlFor(cfg.workspace_id, cfg).getAuthorizeUrlAsync('', undefined, {});
  res.redirect(url);
});

// Step 2: the identity provider posts the signed answer here.
router.post('/:workspaceId/acs', limit, express.urlencoded({ extended: false, limit: '200kb' }), async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.workspaceId)) return res.status(404).end();
  const wid = Number(req.params.workspaceId);
  const cfg = await one(`SELECT * FROM sso_configs WHERE workspace_id = $1 AND enabled`, [wid]);
  if (!cfg || !req.body?.SAMLResponse) return back(res, 'not_configured');
  let email;
  try {
    const { profile } = await samlFor(wid, cfg).validatePostResponseAsync({ SAMLResponse: req.body.SAMLResponse });
    email = profile ? emailFromProfile(profile) : null;
  } catch (err) {
    await audit(req, 'sso.failed', { workspaceId: wid, meta: { reason: String(err.message).slice(0, 120) } });
    return back(res, 'invalid_response');
  }
  // The identity provider may only vouch for addresses at the company's own domains.
  if (!email || !isEmail(email) || !cfg.domains.includes(domainOf(email))) {
    await audit(req, 'sso.failed', { workspaceId: wid, meta: { reason: 'email not allowed' } });
    return back(res, 'email_not_allowed');
  }
  let user = await one(`SELECT * FROM users WHERE email = $1`, [email]);
  if (!user) user = await one(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *`, [email, await hash(randomPassword())]);
  await query(`INSERT INTO memberships (user_id, workspace_id, role, provisioned_by) VALUES ($1, $2, $3, 'sso') ON CONFLICT DO NOTHING`,
    [user.id, wid, cfg.default_role === 'viewer' ? 'viewer' : 'member']);
  await audit(req, 'sso.login', { workspaceId: wid, actorId: user.id, target: user.id });
  // The token travels in the URL fragment, which browsers never send to servers or put in referrers.
  res.redirect(`${frontendBase()}/sso#token=${sign(user)}`);
});

export default router;
