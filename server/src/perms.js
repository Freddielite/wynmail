// Per-feature permissions. A role gives a default set; a member can also carry an explicit list that replaces it.
export const PERMISSIONS = {
  'contacts.write': 'Add, edit and import contacts',
  'contacts.delete': 'Delete contacts and clean the list',
  'contacts.export': 'Export contacts and reports to CSV',
  'lists.write': 'Create and delete lists',
  'templates.write': 'Create, edit and delete templates and pictures',
  'campaigns.write': 'Create and edit campaigns, run checks, send test emails',
  'campaigns.send': 'Send, schedule, resend, resume and release held campaigns',
  'automations.write': 'Create and edit automations',
  'forms.write': 'Create and edit signup forms',
  'segments.write': 'Create and edit segments',
  'settings.write': 'Change workspace settings',
  'apikeys.manage': 'See, create and revoke API keys',
  'audit.read': 'Read the activity log',
  'prospector.use': 'Find business emails on company websites',
  'team.manage': 'Add and remove people, change permissions, set up SSO'
};
export const ALL = Object.keys(PERMISSIONS);

const MEMBER_DEFAULT = ALL.filter((p) => !['contacts.export', 'apikeys.manage', 'audit.read', 'team.manage', 'prospector.use'].includes(p));
export const ROLE_DEFAULTS = {
  owner: ALL,
  admin: ALL,
  member: MEMBER_DEFAULT,
  viewer: []
};

// What the signed-in person may do in this workspace. Platform admins and owners always have everything.
export function permissionsOf(membership, { platformAdmin = false } = {}) {
  if (platformAdmin || membership.role === 'owner' || membership.role === 'admin') return ALL;
  if (Array.isArray(membership.permissions)) return membership.permissions.filter((p) => ALL.includes(p));
  return ROLE_DEFAULTS[membership.role] || [];
}

export const cleanPermissions = (list) => (Array.isArray(list) ? [...new Set(list.filter((p) => ALL.includes(p)))] : null);

// Which permission a request needs. Reading needs none (everyone in the workspace can look).
// Anything not listed here and not a read is refused, so a new route is closed until it is listed.
const RULES = [
  [/^(GET|POST|PUT|DELETE)$/, /^\/prospector/, 'prospector.use'],
  [/^GET$/, /^\/api-keys/, 'apikeys.manage'],
  [/^GET$/, /^\/(contacts\/export|campaigns\/\d+\/export)$/, 'contacts.export'],
  [/^GET$/, /^\/audit$/, 'audit.read'],
  [/^GET$/, /^\/(sso|scim-tokens)/, 'team.manage'],
  [/^(GET|HEAD|OPTIONS)$/, /./, null],
  [/^POST$/, /^\/campaigns\/\d+\/(send|resend|resume|release)$/, 'campaigns.send'],
  [/^(POST|PUT|DELETE)$/, /^\/campaigns/, 'campaigns.write'],
  [/^POST$/, /^\/(precheck|test-email)$/, 'campaigns.write'],
  [/^(POST|PUT|DELETE)$/, /^\/contacts\/\d+\/unblock$/, 'team.manage'],
  [/^POST$/, /^\/suppressions\/\d+\/unblock$/, 'team.manage'],
  [/^POST$/, /^\/hygiene\/clean$/, 'contacts.delete'],
  [/^DELETE$/, /^\/contacts/, 'contacts.delete'],
  [/^(POST|PUT|DELETE)$/, /^\/contacts/, 'contacts.write'],
  [/^(POST|PUT|DELETE)$/, /^\/profile/, 'contacts.write'],
  [/^(POST|PUT|DELETE)$/, /^\/lists/, 'lists.write'],
  [/^(POST|PUT|DELETE)$/, /^\/(templates|media)/, 'templates.write'],
  [/^(POST|PUT|DELETE)$/, /^\/automations/, 'automations.write'],
  [/^(POST|PUT|DELETE)$/, /^\/forms/, 'forms.write'],
  [/^(POST|PUT|DELETE)$/, /^\/segments/, 'segments.write'],
  [/^(POST|PUT|DELETE)$/, /^\/api-keys/, 'apikeys.manage'],
  [/^(POST|PUT|DELETE)$/, /^\/(members|sso|scim-tokens)/, 'team.manage'],
  [/^PUT$/, /^\/$/, 'settings.write'],
  [/^POST$/, /^\/deleted\/\d+\/restore$/, null],
  [/^POST$/, /^\/notifications\/read$/, null],
  [/^DELETE$/, /^\/deleted\/\d+$/, 'team.manage']
];

export function requiredPermission(method, path) {
  for (const [m, p, perm] of RULES) if (m.test(method) && p.test(path)) return { perm };
  return { denied: true };
}
