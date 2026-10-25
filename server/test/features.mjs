// Per-feature permissions, contact undo, MFA, SCIM, SAML SSO and the spam-risk hold.
// Run against a live server on an empty database with FORCE_PROVIDER=console (default PUBLIC_URL).
import crypto from 'crypto';
import zlib from 'zlib';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SignedXml } from 'xml-crypto';
import { SMTPServer } from 'smtp-server';
import { codeFor, stepAt } from '../src/totp.js';

const BASE = process.env.BASE || 'http://localhost:4000';
// SSO and SCIM are off by default. Start the server with ENABLE_SSO=1 and run this with ENABLE_SSO=1 to include them.
const SSO = process.env.ENABLE_SSO === '1';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
async function call(method, p, { token, key, body, headers = {}, raw } = {}) {
  const res = await fetch(BASE + p, { method, redirect: 'manual', headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: raw ? raw : body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = {}; try { data = JSON.parse(text); } catch { data = { text }; }
  return { status: res.status, headers: res.headers, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).data;
const resetLinkToken = (link) => new URL(link).searchParams.get('token');

const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', '/api/workspaces/1', { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: 'Abuja' } });
const W = (await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'o@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } })).data.id;
const O = (await login('o@acme.ng', 'acme-pass-99')).token;
await call('PUT', `/api/workspaces/${W}`, { token: O, body: { from_email: 'hello@acme.ng', footer_address: 'Lagos' } });
const w = (p) => `/api/workspaces/${W}${p}`;

/* ---------- per-feature permissions ---------- */
const inv = await call('POST', w('/members'), { token: O, body: { email: 'marketer@acme.ng', permissions: ['campaigns.write', 'templates.write'] } });
await call('POST', '/api/auth/reset', { body: { token: resetLinkToken(inv.data.invite_link), password: 'market-pass-1' } });
const M = (await login('marketer@acme.ng', 'market-pass-1')).token;
const mine = await call('GET', w('/permissions'), { token: M });
check('a member reports exactly the permissions they were given', JSON.stringify(mine.data.mine.sort()) === JSON.stringify(['campaigns.write', 'templates.write']), JSON.stringify(mine.data));
const baseList = (await call('POST', w('/lists'), { token: O, body: { name: 'Everyone' } })).data;
const cc = await call('POST', w('/campaigns'), { token: M, body: { name: 'Draft', subject: 'Hello', html: '<p>Hi</p>', list_id: baseList.id } });
check('with campaigns.write they can create a campaign', cc.status === 200, JSON.stringify(cc.data));
check('without contacts.write they cannot add a contact', (await call('POST', w('/contacts'), { token: M, body: { email: 'x@example.com' } })).status === 403);
check('without campaigns.send they cannot send', (await call('POST', w('/campaigns/1/send'), { token: M, body: {} })).status === 403);
check('without settings.write they cannot change settings', (await call('PUT', w(''), { token: M, body: { from_name: 'Nope' } })).status === 403);
check('they can still read', (await call('GET', w('/contacts'), { token: M })).status === 200);
const uid = (await call('GET', '/api/auth/me', { token: M })).data.user.id;
check('a member cannot change their own permissions', (await call('PUT', w(`/members/${uid}/permissions`), { token: M, body: { permissions: ['team.manage'] } })).status === 403);
check('unknown permission names are dropped', (await call('PUT', w(`/members/${uid}/permissions`), { token: O, body: { permissions: ['contacts.write', 'launch.rockets'] } })).data.permissions?.join() === 'contacts.write');
check('the new permission works at once', (await call('POST', w('/contacts'), { token: M, body: { email: 'x@example.com' } })).status === 200);
check('and the old ones are gone', (await call('POST', w('/campaigns'), { token: M, body: { name: 'D2', subject: 'S', html: '<p>x</p>' } })).status === 403);
await call('PUT', w(`/members/${uid}/permissions`), { token: O, body: { permissions: null } });
check('null goes back to the member defaults', (await call('GET', w('/permissions'), { token: M })).data.mine.includes('campaigns.send'));
check('audit log records permission changes', (await call('GET', w('/audit'), { token: O })).data.some((r) => r.action === 'member.permissions_changed'));

/* ---------- contact undo ---------- */
const list = (await call('POST', w('/lists'), { token: O, body: { name: 'Buyers' } })).data;
const ada = (await call('POST', w('/contacts'), { token: O, body: { email: 'ada@example.com', first_name: "O'Brien", list_id: list.id, tags: ['vip'] } })).data;
await call('DELETE', w(`/contacts/${ada.id}`), { token: M }); // member with defaults may delete (soft)
check('deleting a contact removes them from the list', !(await call('GET', w(`/contacts?listId=${list.id}`), { token: O })).data.some((c) => c.id === ada.id));
const held = (await call('GET', w('/deleted'), { token: O })).data.find((d) => d.kind === 'contact');
check('the contact is held for undo', held && held.label === 'ada@example.com', JSON.stringify(held));
const back = await call('POST', w(`/deleted/${held.id}/restore`), { token: O });
check('restore brings back name, tags and list membership', back.status === 200 && back.data.first_name === "O'Brien" && (back.data.tags || []).includes('vip')
  && (await call('GET', w(`/contacts?listId=${list.id}`), { token: O })).data.some((c) => c.email === 'ada@example.com'), JSON.stringify(back.data));
await call('DELETE', w(`/contacts/${back.data.id}`), { token: O });
await call('POST', w('/contacts'), { token: O, body: { email: 'ada@example.com' } });
const held2 = (await call('GET', w('/deleted'), { token: O })).data.find((d) => d.kind === 'contact');
check('restoring over a re-added address is refused', (await call('POST', w(`/deleted/${held2.id}/restore`), { token: O })).status === 409);
check('a teammate cannot erase for good', (await call('DELETE', w(`/contacts/9999?permanent=1`), { token: M })).status === 403);
const bea = (await call('POST', w('/contacts'), { token: O, body: { email: 'bea@example.com' } })).data;
await call('DELETE', w(`/contacts/${bea.id}?permanent=1`), { token: O });
check('the owner can erase for good: nothing is held', !(await call('GET', w('/deleted'), { token: O })).data.some((d) => d.label === 'bea@example.com'));
check('the owner can erase a held record at once', (await call('DELETE', w(`/deleted/${held2.id}`), { token: O })).status === 200
  && !(await call('GET', w('/deleted'), { token: O })).data.some((d) => d.id === held2.id));

/* ---------- MFA ---------- */
await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Nina', owner_email: 'nina@example.com', password: 'nina-pass-123' } });
let N = (await login('nina@example.com', 'nina-pass-123')).token;
const setup = await call('POST', '/api/auth/mfa/setup', { token: N });
check('setup returns a secret and an authenticator link', /^[A-Z2-7]{32}$/.test(setup.data.secret) && setup.data.otpauth_url.startsWith('otpauth://totp/'));
check('a wrong first code is refused', (await call('POST', '/api/auth/mfa/enable', { token: N, body: { code: '000000' } })).status === 400);
const secret = setup.data.secret;
const en = await call('POST', '/api/auth/mfa/enable', { token: N, body: { code: codeFor(secret, stepAt()) } });
check('confirming a code turns it on and gives 10 recovery codes', en.status === 200 && en.data.recovery_codes.length === 10, JSON.stringify(en.data).slice(0, 120));
const codes = en.data.recovery_codes;
N = en.data.token;
const step1 = await login('nina@example.com', 'nina-pass-123');
check('password alone no longer gives a session', step1.mfa_required === true && !step1.token);
check('the half-done sign-in cannot be used as a session', (await call('GET', '/api/auth/me', { token: step1.mfa_token })).status === 401);
check('a wrong code is refused', (await call('POST', '/api/auth/login/mfa', { body: { mfa_token: step1.mfa_token, code: '123456' } })).status === 401);
const goodCode = codeFor(secret, stepAt() + 1);
const done = await call('POST', '/api/auth/login/mfa', { body: { mfa_token: step1.mfa_token, code: goodCode } });
check('a right code finishes the sign-in', done.status === 200 && !!done.data.token && (await call('GET', '/api/auth/me', { token: done.data.token })).status === 200);
const step2 = await login('nina@example.com', 'nina-pass-123');
check('the same code cannot be used twice', (await call('POST', '/api/auth/login/mfa', { body: { mfa_token: step2.mfa_token, code: goodCode } })).status === 401);
const rec = await call('POST', '/api/auth/login/mfa', { body: { mfa_token: step2.mfa_token, recovery_code: codes[0] } });
check('a recovery code signs you in (lost phone)', rec.status === 200 && rec.data.recovery_used === true);
const step3 = await login('nina@example.com', 'nina-pass-123');
check('each recovery code works once', (await call('POST', '/api/auth/login/mfa', { body: { mfa_token: step3.mfa_token, recovery_code: codes[0] } })).status === 401);
check('status shows 9 recovery codes left', (await call('GET', '/api/auth/mfa', { token: rec.data.token })).data.recovery_codes_left === 9);
check('turning it off needs the password', (await call('POST', '/api/auth/mfa/disable', { token: rec.data.token, body: { password: 'wrong-pass-123', recovery_code: codes[1] } })).status === 400);
const ninaId = (await call('GET', '/api/auth/me', { token: rec.data.token })).data.user.id;
check('an admin can reset MFA for someone who lost everything', (await call('POST', `/api/admin/users/${ninaId}/reset-mfa`, { token: A })).status === 200);
check('after the reset, password alone works again', !!(await login('nina@example.com', 'nina-pass-123')).token);
check('non-admins cannot reset MFA', (await call('POST', `/api/admin/users/${ninaId}/reset-mfa`, { token: O })).status === 403);

// A view-only teammate, used by the spam-risk checks below.
const vinv = await call('POST', w('/members'), { token: O, body: { email: 'viewer@acme.ng', role: 'viewer' } });
await call('POST', '/api/auth/reset', { body: { token: resetLinkToken(vinv.data.invite_link), password: 'viewer-pass-1' } });
const VW = (await login('viewer@acme.ng', 'viewer-pass-1')).token;

if (!SSO) {
  check('SSO is off: no SSO routes', (await call('GET', '/sso/start?email=a@acme.ng')).status === 404 && (await call('GET', `/sso/${W}/metadata`)).status === 404);
  check('SSO is off: no SCIM routes', (await call('GET', '/scim/v2/Users')).status === 404);
  check('SSO is off: no SSO settings endpoint', (await call('GET', w('/sso'), { token: O })).status === 403 || (await call('GET', w('/sso'), { token: O })).status === 404);
}
if (SSO) {
/* ---------- SSO config, SCIM ---------- */
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-'));
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyDir}/k.pem -out ${keyDir}/c.pem -days 2 -subj "/CN=idp.example.com" 2>/dev/null`);
const idpKey = fs.readFileSync(`${keyDir}/k.pem`, 'utf8'), idpCert = fs.readFileSync(`${keyDir}/c.pem`, 'utf8');
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyDir}/k2.pem -out ${keyDir}/c2.pem -days 2 -subj "/CN=evil" 2>/dev/null`);
const evilKey = fs.readFileSync(`${keyDir}/k2.pem`, 'utf8');

check('the owner cannot edit SSO (only Wyntek can)', (await call('PUT', w('/sso'), { token: O, body: { domains: ['gmail.com'] } })).status === 403);
check('the owner can read SSO settings and the values for their IT team', (await call('GET', w('/sso'), { token: O })).data.acs_url?.includes(`/sso/${W}/acs`));
check('turning SSO on without a certificate is refused', (await call('PUT', w('/sso'), { token: A, body: { enabled: true, domains: ['acme.ng'] } })).status === 400);
const cfg = await call('PUT', w('/sso'), { token: A, body: { enabled: true, domains: ['acme.ng'], idp_entity_id: 'https://idp.example.com/meta', idp_sso_url: 'https://idp.example.com/sso', idp_cert: idpCert } });
check('Wyntek can set up SSO; the certificate is never echoed back', cfg.status === 200 && cfg.data.enabled && cfg.data.has_cert && !JSON.stringify(cfg.data).includes('BEGIN CERTIFICATE'), JSON.stringify(cfg.data).slice(0, 200));
check('a domain cannot be claimed by two workspaces', (await call('PUT', '/api/workspaces/1/sso', { token: A, body: { domains: ['acme.ng'] } })).status === 400);

check('non-admin cannot mint SCIM tokens', (await call('POST', w('/scim-tokens'), { token: O })).status === 403);
const tok = (await call('POST', w('/scim-tokens'), { token: A })).data.token;
const scim = (method, p, body, t = tok) => call(method, `/scim/v2${p}`, { key: t, body, headers: { 'Content-Type': 'application/scim+json' } });
check('SCIM refuses a bad token', (await scim('GET', '/Users', undefined, 'wmscim_nope')).status === 401);
check('SCIM refuses a normal API key or session token', (await scim('GET', '/Users', undefined, O)).status === 401);
check('SCIM advertises what it supports', (await scim('GET', '/ServiceProviderConfig')).data.patch?.supported === true);

await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Sam', owner_email: 'sam@acme.ng', password: 'sam-pass-1234' } });
const S = (await login('sam@acme.ng', 'sam-pass-1234')).token;
check('before provisioning, Sam has no access to Acme', (await call('GET', w('/contacts'), { token: S })).status === 403);
const made = await scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'Sam@Acme.ng', externalId: 'okta-42', name: { givenName: 'Sam', familyName: "D'Souza" }, active: true });
check('IT provisions Sam: 201 and active', made.status === 201 && made.data.active === true && made.data.userName === 'sam@acme.ng', JSON.stringify(made.data));
check('Sam now has access', (await call('GET', w('/contacts'), { token: S })).status === 200);
check('provisioning twice is a 409, not a duplicate', (await scim('POST', '/Users', { userName: 'sam@acme.ng' })).status === 409);
check('an address outside the company domain is refused', (await scim('POST', '/Users', { userName: 'someone@gmail.com' })).status === 400);
check('lookup by userName works', (await scim('GET', '/Users?filter=userName%20eq%20%22sam%40acme.ng%22')).data.Resources?.[0]?.id === made.data.id);
const off = await scim('PATCH', `/Users/${made.data.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] });
check('IT offboards Sam (Azure style): inactive', off.status === 200 && off.data.active === false);
check('Sam loses access on the very next request', (await call('GET', w('/contacts'), { token: S })).status === 403);
check('Sam can still use his own workspace', (await call('GET', '/api/auth/me', { token: S })).status === 200);
const on = await scim('PATCH', `/Users/${made.data.id}`, { Operations: [{ op: 'replace', value: { active: true } }] });
check('and is restored when IT reactivates (Okta style)', on.data.active === true && (await call('GET', w('/contacts'), { token: S })).status === 200);
await scim('DELETE', `/Users/${made.data.id}`);
check('DELETE removes access too', (await call('GET', w('/contacts'), { token: S })).status === 403);
const ownerId = (await call('GET', '/api/auth/me', { token: O })).data.user.id;
check('SCIM cannot remove the owner', (await scim('DELETE', `/Users/${ownerId}`)).status === 204 && (await call('GET', w('/contacts'), { token: O })).status === 200);
check('SCIM actions are in the audit log', (await call('GET', w('/audit'), { token: O })).data.some((r) => r.action === 'scim.user_deactivated'));

/* ---------- SAML ---------- */
check('metadata is served for the customer IT team', (await call('GET', `/sso/${W}/metadata`)).data.text?.includes('EntityDescriptor'));
check('unknown domain has no SSO', (await call('GET', '/sso/start?email=a@unknown.com')).status === 404);
const nav = await call('GET', '/sso/start?email=a@unknown.com', { headers: { Accept: 'text/html' } });
check('a browser is sent back to sign-in with a message, not shown JSON', nav.status === 302 && /\/login\?sso_error=not_configured/.test(nav.headers.get('location') || ''));
const start = await call('GET', '/sso/start?email=newhire@acme.ng');
check('start redirects to the identity provider with a request', start.status === 302 && start.headers.get('location').startsWith('https://idp.example.com/sso?SAMLRequest='), start.headers.get('location'));
const reqXml = zlib.inflateRawSync(Buffer.from(new URL(start.headers.get('location')).searchParams.get('SAMLRequest'), 'base64')).toString();
const requestId = reqXml.match(/ID="([^"]+)"/)[1];
const acs = `http://localhost:4000/sso/${W}/acs`, spId = `http://localhost:4000/sso/${W}/metadata`;
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
function assertion({ email, inResponseTo = requestId, key = idpKey, audience = spId }) {
  const id = '_' + crypto.randomBytes(8).toString('hex');
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${id}" Version="2.0" IssueInstant="${iso()}" Destination="${acs}" InResponseTo="${inResponseTo}"><saml:Issuer>https://idp.example.com/meta</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${id}" Version="2.0" IssueInstant="${iso()}"><saml:Issuer>https://idp.example.com/meta</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(300000)}" Recipient="${acs}" InResponseTo="${inResponseTo}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(-60000)}" NotOnOrAfter="${iso(300000)}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso()}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion></samlp:Response>`;
  const sig = new SignedXml({ privateKey: key, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: "//*[local-name(.)='Assertion']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
  return sig.getSignedXml();
}
const post = (xml) => call('POST', `/sso/${W}/acs`, { raw: 'SAMLResponse=' + encodeURIComponent(Buffer.from(xml).toString('base64')), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
const goodXml = assertion({ email: 'newhire@acme.ng' });
const ok = await post(goodXml);
check('a correctly signed response signs the person in', ok.status === 302 && /\/sso#token=ey/.test(ok.headers.get('location') || ''), ok.headers.get('location'));
const ssoToken = (ok.headers.get('location') || '').split('#token=')[1];
check('the token works and the new hire was added to the workspace', (await call('GET', w('/contacts'), { token: ssoToken })).status === 200);
check('the same response cannot be replayed', /sso_error=/.test((await post(goodXml)).headers.get('location') || ''));
const start2 = await call('GET', '/sso/start?email=newhire@acme.ng');
const rid2 = zlib.inflateRawSync(Buffer.from(new URL(start2.headers.get('location')).searchParams.get('SAMLRequest'), 'base64')).toString().match(/ID="([^"]+)"/)[1];
const tampered = assertion({ email: 'newhire@acme.ng', inResponseTo: rid2 }).replace('newhire@acme.ng', 'owner@acme.ng');
check('a tampered response is rejected', /sso_error=invalid_response/.test((await post(tampered)).headers.get('location') || ''));
const start3 = await call('GET', '/sso/start?email=newhire@acme.ng');
const rid3 = zlib.inflateRawSync(Buffer.from(new URL(start3.headers.get('location')).searchParams.get('SAMLRequest'), 'base64')).toString().match(/ID="([^"]+)"/)[1];
check('a response signed by someone else is rejected', /sso_error=invalid_response/.test((await post(assertion({ email: 'newhire@acme.ng', inResponseTo: rid3, key: evilKey }))).headers.get('location') || ''));
const start4 = await call('GET', '/sso/start?email=newhire@acme.ng');
const rid4 = zlib.inflateRawSync(Buffer.from(new URL(start4.headers.get('location')).searchParams.get('SAMLRequest'), 'base64')).toString().match(/ID="([^"]+)"/)[1];
check('a valid response for an address outside the domain is rejected', /sso_error=email_not_allowed/.test((await post(assertion({ email: 'ceo@gmail.com', inResponseTo: rid4 }))).headers.get('location') || ''));
check('an unsolicited response (no request of ours) is rejected', /sso_error=invalid_response/.test((await post(assertion({ email: 'newhire@acme.ng', inResponseTo: '_never_asked' }))).headers.get('location') || ''));
check('garbage is rejected', /sso_error=/.test((await post('<nope/>')).headers.get('location') || ''));
await call('PUT', w('/sso'), { token: A, body: { enforce: true } });
check('once enforced, passwords are refused for company addresses', (await call('POST', '/api/auth/login', { body: { email: 'sam@acme.ng', password: 'sam-pass-1234' } })).status === 403);
check('platform admins can still use a password (break glass)', !!(await login('admin@wyntek.ng', 'correct-horse-1')).token);
await call('PUT', w('/sso'), { token: A, body: { enforce: false } });

}

/* ---------- spam-risk hold ---------- */
const reader = (await call('POST', w('/lists'), { token: O, body: { name: 'Readers' } })).data;
for (let i = 0; i < 3; i++) await call('POST', w('/contacts'), { token: O, body: { email: `reader${i}@example.com`, list_id: reader.id } });
const junk = (await call('POST', w('/campaigns'), { token: O, body: { name: 'Junk', list_id: reader.id,
  subject: 'FREE!!! ACT NOW!!! WIN $$$ CLICK HERE',
  html: '<p>Congratulations winner! Act now, limited time, 100% free, no obligation, risk free, click here, buy now, cash bonus, you have been selected</p><a href="http://bit.ly/abc">click here</a> <a href="http://tinyurl.com/x">here</a> <a href="https://paypal.com/login">http://evil.example.net/login</a>' } })).data;
const risk = await call('GET', w(`/campaigns/${junk.id}/risk`), { token: O });
check('the risk report scores an obviously bad email high, with reasons', risk.data.risk >= 60 && risk.data.reasons.length >= 3, JSON.stringify(risk.data).slice(0, 300));
const sent1 = await call('POST', w(`/campaigns/${junk.id}/send`), { token: O, body: {} });
check('sending it is held, not sent', sent1.status === 200 && sent1.data.held === true && sent1.data.queued === 0, JSON.stringify(sent1.data).slice(0, 200));
check('the campaign is marked needs_review with its score', (await call('GET', w('/campaigns'), { token: O })).data.find((c) => c.id === junk.id)?.status === 'needs_review');
const notes = await call('GET', w('/notifications'), { token: O });
check('the owner has an in-app notification', notes.data.unread >= 1 && notes.data.items.some((n) => n.kind === 'risk_hold' && n.campaign_id === junk.id));
check('and an email went out', fs.readFileSync(process.env.LOG || '/tmp/srv.log', 'utf8').includes('A campaign was held'));
check('marking read clears the count', (await call('POST', w('/notifications/read'), { token: O })).status === 200 && (await call('GET', w('/notifications'), { token: O })).data.unread === 0);
check('a teammate without campaigns.send cannot override', (await call('POST', w(`/campaigns/${junk.id}/send`), { token: VW, body: { send_anyway: true } })).status === 403);
const forced = await call('POST', w(`/campaigns/${junk.id}/send`), { token: O, body: { send_anyway: true } });
check('send anyway goes ahead', forced.status === 200 && forced.data.queued === 3, JSON.stringify(forced.data));
check('the override is in the audit log', (await call('GET', w('/audit'), { token: O })).data.some((r) => r.action === 'campaign.risk_override' && Number(r.target) === junk.id));
const clean = (await call('POST', w('/campaigns'), { token: O, body: { name: 'Clean', list_id: reader.id, subject: 'Our March newsletter', html: '<p>Hello, here is what we shipped this month. Read the full notes on our site and tell us what you think about the new editor.</p><p><a href="https://acme.ng/news">Read the March notes</a></p>' } })).data;
check('a normal email is not held', (await call('POST', w(`/campaigns/${clean.id}/send`), { token: O, body: {} })).data.queued === 3);
check('only the owner can loosen the guard', (await call('PUT', w(''), { token: M, body: { risk_hold_enabled: false } })).status === 403);
check('the owner can set the threshold', (await call('PUT', w(''), { token: O, body: { risk_threshold: 90 } })).data.risk_threshold === 90);
check('a threshold outside 10 to 100 is refused', (await call('PUT', w(''), { token: O, body: { risk_threshold: 5 } })).status === 400);

/* ---------- mailboxes (SMTP) ---------- */
const smtpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtpcert-'));
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${smtpDir}/k.pem -out ${smtpDir}/c.pem -days 2 -subj "/CN=localhost" 2>/dev/null`);
const smtpInbox = [];
const smtp = new SMTPServer({ key: fs.readFileSync(`${smtpDir}/k.pem`), cert: fs.readFileSync(`${smtpDir}/c.pem`),
  onAuth(a, sess, cb) { return a.password === 'app-pass' ? cb(null, { user: a.username }) : cb(Object.assign(new Error('bad'), { responseCode: 535 })); },
  onData(stream, sess, cb) { let raw = ''; stream.on('data', (c) => { raw += c; }); stream.on('end', () => { smtpInbox.push(raw); cb(); }); } });
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
const smtpPort = smtp.server.address().port;
const mb = { host: '127.0.0.1', port: smtpPort, username: 'hello@acme.ng', password: 'app-pass' };
check('mailboxes are owner only by default', (await call('GET', w('/mailboxes'), { token: M })).status === 403 && (await call('GET', w('/mailboxes'), { token: VW })).status === 403);
check('the owner sees an empty list and the limits', (await call('GET', w('/mailboxes'), { token: O })).data.default_cap === 30);
check('a wrong password is refused with a hint', (await call('POST', w('/mailboxes'), { token: O, body: { ...mb, password: 'nope' } })).data.kind === 'auth');
check('a sending address outside your domain is refused', (await call('POST', w('/mailboxes'), { token: O, body: { ...mb, from_email: 'ceo@other.com' } })).status === 400);
check('a daily limit outside 1 to 500 is refused', (await call('POST', w('/mailboxes'), { token: O, body: { ...mb, daily_cap: 0 } })).status === 400 && (await call('POST', w('/mailboxes'), { token: O, body: { ...mb, daily_cap: 501 } })).status === 400);
check('a bad server name is refused', (await call('POST', w('/mailboxes'), { token: O, body: { ...mb, host: 'not a host' } })).status === 400);
const box = await call('POST', w('/mailboxes'), { token: O, body: { ...mb, label: 'Main' } });
check('a working mailbox is added, with the default limit of 30', box.status === 200 && box.data.daily_cap === 30 && box.data.from_email === 'hello@acme.ng' && !JSON.stringify(box.data).includes('app-pass'), JSON.stringify(box.data));
check('the same mailbox cannot be added twice', (await call('POST', w('/mailboxes'), { token: O, body: mb })).status === 409);
check('the limit can be changed', (await call('PUT', w(`/mailboxes/${box.data.id}`), { token: O, body: { daily_cap: 25 } })).data.daily_cap === 25);
check('a new password is checked before it replaces the old one', (await call('PUT', w(`/mailboxes/${box.data.id}`), { token: O, body: { password: 'typo' } })).status === 400);
const tst = await call('POST', w(`/mailboxes/${box.data.id}/test`), { token: O });
check('the test button sends to your own address through that mailbox', tst.status === 200 && tst.data.sent_to === 'o@acme.ng' && smtpInbox.length === 1 && /^To: .*o@acme\.ng/im.test(smtpInbox[0]), JSON.stringify(tst.data));
check('and it counts towards the daily limit', (await call('GET', w('/mailboxes'), { token: O })).data.mailboxes[0].sent_today === 1);
check('workspace mailbox settings are in the activity log, without the password', JSON.stringify((await call('GET', w('/audit'), { token: O })).data.filter((r) => r.action.startsWith('mailbox.'))).includes('mailbox.created') && !JSON.stringify((await call('GET', w('/audit'), { token: O })).data).includes('app-pass'));
check('the owner cannot switch the provider themselves', (await call('PUT', w(''), { token: O, body: { provider: 'smtp' } })).data.provider !== 'smtp');
check('Wyntek can choose SMTP for a workspace', (await call('PUT', w(''), { token: A, body: { provider: 'smtp' } })).data.provider === 'smtp');
await call('PUT', w(''), { token: A, body: { provider: 'resend' } });
check('a mailbox can be removed', (await call('DELETE', w(`/mailboxes/${box.data.id}`), { token: O })).status === 200 && (await call('GET', w('/mailboxes'), { token: O })).data.mailboxes.length === 0);
smtp.close();

/* ---------- prospector API ---------- */
check('prospector is off for ordinary members by default', (await call('GET', w('/prospector/jobs'), { token: M })).status === 403);
check('viewers cannot use it either', (await call('GET', w('/prospector/info'), { token: VW })).status === 403);
check('the owner can', (await call('GET', w('/prospector/info'), { token: O })).data.max_sites === 100);
await call('PUT', w(`/members/${uid}/permissions`), { token: O, body: { permissions: ['prospector.use'] } });
check('it can be granted to one person', (await call('GET', w('/prospector/jobs'), { token: M })).status === 200);
check('an empty search is refused', (await call('POST', w('/prospector/jobs'), { token: O, body: { text: '  ' } })).status === 400);
check('local and private addresses are refused', (await call('POST', w('/prospector/jobs'), { token: O, body: { text: 'localhost\n127.0.0.1\n10.0.0.1' } })).status === 400);
check('too many at once is refused', (await call('POST', w('/prospector/jobs'), { token: O, body: { sites: Array.from({ length: 101 }, (_, i) => `site${i}.ng`) } })).status === 400);
const pj = await call('POST', w('/prospector/jobs'), { token: O, body: { text: 'wynmail-test-nonexistent.ng\nwww.wynmail-test-nonexistent.ng\nnot a site', csv: 'Website\nanother-nonexistent-test.ng' } });
check('a search starts: duplicates merged, rubbish reported', pj.status === 200 && pj.data.job.total_sites === 2 && pj.data.rejected_count >= 1, JSON.stringify(pj.data).slice(0, 200));
check('only one search at a time', (await call('POST', w('/prospector/jobs'), { token: O, body: { text: 'third-nonexistent-test.ng' } })).status === 409);
check('another workspace cannot read it', (await call('GET', `/api/workspaces/1/prospector/jobs/${pj.data.job.id}`, { token: A })).status === 404);
check('it can be stopped', (await call('POST', w(`/prospector/jobs/${pj.data.job.id}/cancel`), { token: O })).status === 200);
const pd = await call('GET', w(`/prospector/jobs/${pj.data.job.id}`), { token: O });
check('a stopped search stays stopped', pd.data.job.status === 'cancelled');
check('starting a search is in the activity log', (await call('GET', w('/audit'), { token: O })).data.some((r) => r.action === 'prospector.job_created'));
const disc = await call('POST', w('/prospector/discover'), { token: O, body: { category: 'restaurants', city: 'Abuja', country: 'NG' } });
check('a business search lists businesses with their website, phone and map page', disc.status === 200 && disc.data.total === 3 && disc.data.with_website === 2 && disc.data.with_email === 1 && disc.data.businesses[0].listed_page.startsWith('https://www.openstreetmap.org/'), JSON.stringify(disc.data).slice(0, 200));
check('a business search needs a real type, city and country', (await call('POST', w('/prospector/discover'), { token: O, body: { category: 'nope', city: 'Abuja', country: 'NG' } })).status === 400
  && (await call('POST', w('/prospector/discover'), { token: O, body: { category: 'hotels', city: 'Abuja"]; out;', country: 'NG' } })).status === 400
  && (await call('POST', w('/prospector/discover'), { token: O, body: { category: 'hotels', city: 'Abuja', country: 'ZZ' } })).status === 400);
check('searching businesses is audit-logged', (await call('GET', w('/audit'), { token: O })).data.some((r) => r.action === 'prospector.discover'));
check('the info call lists the types and countries', Object.keys((await call('GET', w('/prospector/info'), { token: O })).data.categories).length >= 10);
const withBiz = await call('POST', w('/prospector/jobs'), { token: O, body: { per_company: 1, businesses: [...disc.data.businesses,
  { name: 'Local', website: 'http://127.0.0.1/', phone: '1' }, { name: 'Fake page', email: 'x@y.ng', listed_page: 'https://evil.example/node/1' }] } });
check('a search can start from the businesses found, keeping their details, ignoring bad entries', withBiz.status === 200 && withBiz.data.job.total_sites === 3 && withBiz.data.job.per_company === 1, JSON.stringify(withBiz.data).slice(0, 200));
const wd = await call('GET', w(`/prospector/jobs/${withBiz.data.job.id}`), { token: O });
check('the sites carry the business name, phone and city', wd.data.sites.some((x) => x.company === 'Test Kitchen One' && x.phone === '+234 800 000 0001'), JSON.stringify(wd.data.sites).slice(0, 200));
await call('POST', w(`/prospector/jobs/${withBiz.data.job.id}/cancel`), { token: O });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
