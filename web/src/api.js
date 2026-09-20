const BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export const store = {
  get token() { return localStorage.getItem('wm_token'); },
  set token(v) { v ? localStorage.setItem('wm_token', v) : localStorage.removeItem('wm_token'); },
  get workspaceId() { return localStorage.getItem('wm_ws'); },
  set workspaceId(v) { v ? localStorage.setItem('wm_ws', v) : localStorage.removeItem('wm_ws'); }
};

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(store.token ? { Authorization: `Bearer ${store.token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

const ws = (path) => `/api/workspaces/${store.workspaceId}${path}`;

export const api = {
  base: BASE,
  forgot: (email) => request('/api/auth/forgot', { method: 'POST', body: { email } }),
  reset: (b) => request('/api/auth/reset', { method: 'POST', body: b }),
  changePassword: (b) => request('/api/auth/password', { method: 'POST', body: b }),
  members: () => request(ws('/members')),
  addMember: (email) => request(ws('/members'), { method: 'POST', body: { email } }),
  removeMember: (id) => request(ws(`/members/${id}`), { method: 'DELETE' }),
  testEmail: (b) => request(ws('/test-email'), { method: 'POST', body: b }),
  register: (b) => request('/api/auth/register', { method: 'POST', body: b }),
  login: (b) => request('/api/auth/login', { method: 'POST', body: b }),
  me: () => request('/api/auth/me'),

  adminWorkspaces: () => request('/api/admin/workspaces'),
  adminCreateWorkspace: (b) => request('/api/admin/workspaces', { method: 'POST', body: b }),
  adminUpdateWorkspace: (id, b) => request(`/api/admin/workspaces/${id}`, { method: 'PUT', body: b }),

  workspace: () => request(ws('')),
  saveWorkspace: (b) => request(ws(''), { method: 'PUT', body: b }),
  stats: () => request(ws('/stats')),

  lists: () => request(ws('/lists')),
  createList: (b) => request(ws('/lists'), { method: 'POST', body: b }),
  deleteList: (id) => request(ws(`/lists/${id}`), { method: 'DELETE' }),

  contacts: (q = '') => request(ws(`/contacts${q}`)),
  createContact: (b) => request(ws('/contacts'), { method: 'POST', body: b }),
  importContacts: (b) => request(ws('/contacts/import'), { method: 'POST', body: b }),
  deleteContact: (id) => request(ws(`/contacts/${id}`), { method: 'DELETE' }),

  templates: () => request(ws('/templates')),
  createTemplate: (b) => request(ws('/templates'), { method: 'POST', body: b }),
  updateTemplate: (id, b) => request(ws(`/templates/${id}`), { method: 'PUT', body: b }),
  deleteTemplate: (id) => request(ws(`/templates/${id}`), { method: 'DELETE' }),

  apiKeys: () => request(ws('/api-keys')),
  createApiKey: (b) => request(ws('/api-keys'), { method: 'POST', body: b }),
  revokeApiKey: (id) => request(ws(`/api-keys/${id}`), { method: 'DELETE' }),
  apiEmails: () => request(ws('/api-emails')),

  campaigns: () => request(ws('/campaigns')),
  createCampaign: (b) => request(ws('/campaigns'), { method: 'POST', body: b }),
  updateCampaign: (id, b) => request(ws(`/campaigns/${id}`), { method: 'PUT', body: b }),
  sendCampaign: (id) => request(ws(`/campaigns/${id}/send`), { method: 'POST' }),
  campaignPreview: (id) => request(ws(`/campaigns/${id}/preview`)),
  campaignMessages: (id) => request(ws(`/campaigns/${id}/messages`))
};
