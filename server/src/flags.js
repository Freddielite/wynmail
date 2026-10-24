// Single sign-on (SAML) and SCIM are built but switched off. Set ENABLE_SSO=1 on the server to turn them on.
// Off means: no /sso or /scim routes, no SSO settings endpoints, no password block, and node-saml is never loaded.
export const SSO_ENABLED = process.env.ENABLE_SSO === '1';
