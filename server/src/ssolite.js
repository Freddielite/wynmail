import { one } from './db.js';
import { SSO_ENABLED } from './flags.js';

export const domainOf = (email) => String(email || '').toLowerCase().split('@')[1] || '';

// True when the person's company requires single sign-on, so a password must not be accepted. Always false while SSO is off.
export const ssoEnforcedFor = async (email) => SSO_ENABLED && !!(await one(`SELECT 1 FROM sso_configs WHERE enabled AND enforce AND $1 = ANY(domains)`, [domainOf(email)]));
