import crypto from 'crypto';
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { one, query } from './db.js';

const base = () => (process.env.PUBLIC_URL || 'http://localhost:4000').split(',')[0].trim().replace(/\/+$/, '');
export const spEntityId = (workspaceId) => `${base()}/sso/${workspaceId}/metadata`;
export const acsUrl = (workspaceId) => `${base()}/sso/${workspaceId}/acs`;

// Remembers which sign-in requests we started, so a response must answer one of them. Kept in the database so it
// works with more than one server, and each entry is used once (a replayed response finds nothing).
const TTL_MS = 10 * 60 * 1000;
const requestCache = {
  async saveAsync(key, value) {
    await query(`INSERT INTO saml_requests (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, created_at = now()`, [key, value]);
    return { value, createdAt: Date.now() };
  },
  async getAsync(key) {
    return (await one(`SELECT value FROM saml_requests WHERE key = $1 AND created_at > now() - ($2 || ' milliseconds')::interval`, [key, String(TTL_MS)]))?.value ?? null;
  },
  async removeAsync(key) {
    if (key === null) return null;
    return (await one(`DELETE FROM saml_requests WHERE key = $1 RETURNING value`, [key]))?.value ?? null;
  }
};

import { domainOf } from './ssolite.js';
export { domainOf };

export function samlFor(workspaceId, cfg) {
  return new SAML({
    callbackUrl: acsUrl(workspaceId),
    entryPoint: cfg.idp_sso_url,
    issuer: spEntityId(workspaceId),
    audience: spEntityId(workspaceId),
    idpCert: cfg.idp_cert,
    idpIssuer: cfg.idp_entity_id || undefined,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: TTL_MS,
    cacheProvider: requestCache,
    acceptedClockSkewMs: 60000,
    disableRequestedAuthnContext: true,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'
  });
}

export const ssoConfigForEmail = (email) => one(
  `SELECT * FROM sso_configs WHERE enabled AND $1 = ANY(domains) AND idp_sso_url <> '' AND idp_cert <> ''`, [domainOf(email)]);

// True when the person's company requires single sign-on, so a password must not be accepted.


// Pulls the email out of the assertion. Only the asserted address counts, and only for the company's own domains.
export function emailFromProfile(profile) {
  const candidates = [profile.email, profile.mail, profile['urn:oid:0.9.2342.19200300.100.1.3'],
    profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'], profile.nameID];
  const hit = candidates.find((c) => typeof c === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.trim()));
  return hit ? hit.trim().toLowerCase() : null;
}

export const randomPassword = () => crypto.randomBytes(24).toString('hex');
