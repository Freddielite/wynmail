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
  if (!res.ok) { const err = new Error(data.error || `request failed (${res.status})`); err.status = res.status; err.data = data; throw err; }
  return data;
}

const ws = (path) => `/api/workspaces/${store.workspaceId}${path}`;

// Downloads a file the API protects with the sign-in token, then hands it to the browser.
async function download(path, filename) {
  const res = await fetch(`${BASE}${path}`, { headers: store.token ? { Authorization: `Bearer ${store.token}` } : {} });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Download failed');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const tz = () => -new Date().getTimezoneOffset(); // minutes ahead of UTC, so charts use the reader's own day

async function uploadMedia(blob, name) {
  const res = await fetch(`${BASE}${ws('/media')}`, {
    method: 'POST', headers: { 'Content-Type': blob.type, 'X-Filename': encodeURIComponent(name), Authorization: `Bearer ${store.token}` }, body: blob
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

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

  forms: () => request(ws('/forms')),
  createForm: (b) => request(ws('/forms'), { method: 'POST', body: b }),
  updateForm: (id, b) => request(ws(`/forms/${id}`), { method: 'PUT', body: b }),
  deleteForm: (id) => request(ws(`/forms/${id}`), { method: 'DELETE' }),
  formSignups: (id) => request(ws(`/forms/${id}/signups`)),

  automations: () => request(ws('/automations')),
  automation: (id) => request(ws(`/automations/${id}`)),
  createAutomation: (b) => request(ws('/automations'), { method: 'POST', body: b }),
  updateAutomation: (id, b) => request(ws(`/automations/${id}`), { method: 'PUT', body: b }),
  setAutomationStatus: (id, active) => request(ws(`/automations/${id}/status`), { method: 'POST', body: { active } }),
  deleteAutomation: (id) => request(ws(`/automations/${id}`), { method: 'DELETE' }),
  automationRuns: (id) => request(ws(`/automations/${id}/runs`)),

  suppressions: () => request(ws('/suppressions')),
  unblockContact: (id, confirm) => request(ws(`/contacts/${id}/unblock`), { method: 'POST', body: { confirm } }),
  unblockAddress: (id, confirm) => request(ws(`/suppressions/${id}/unblock`), { method: 'POST', body: { confirm } }),
  duplicateCampaign: (id) => request(ws(`/campaigns/${id}/duplicate`), { method: 'POST' }),
  domainCheck: () => request(ws('/domain-check')),
  exportContacts: () => download(ws('/contacts/export'), 'contacts.csv'),
  exportCampaign: (id) => download(ws(`/campaigns/${id}/export`), `campaign-${id}-report.csv`),

  media: () => request(ws('/media')),
  uploadMedia,
  deleteMedia: (id, force) => request(ws(`/media/${id}${force ? '?force=1' : ''}`), { method: 'DELETE' }),
  analyticsOverview: (days) => request(ws(`/analytics/overview?days=${days}&tz=${tz()}`)),
  campaignAnalytics: (id) => request(ws(`/analytics/campaigns/${id}?tz=${tz()}`)),
  segments: () => request(ws('/segments')),
  segment: (id) => request(ws(`/segments/${id}`)),
  previewSegment: (definition) => request(ws('/segments/preview'), { method: 'POST', body: { definition } }),
  createSegment: (b) => request(ws('/segments'), { method: 'POST', body: b }),
  updateSegment: (id, b) => request(ws(`/segments/${id}`), { method: 'PUT', body: b }),
  deleteSegment: (id) => request(ws(`/segments/${id}`), { method: 'DELETE' }),
  profile: (id) => request(ws(`/profile/${id}`)),
  updateProfile: (id, b) => request(ws(`/profile/${id}`), { method: 'PUT', body: b }),
  addToList: (id, listId) => request(ws(`/profile/${id}/lists`), { method: 'POST', body: { list_id: listId } }),
  removeFromList: (id, listId) => request(ws(`/profile/${id}/lists/${listId}`), { method: 'DELETE' }),

  campaigns: () => request(ws('/campaigns')),
  createCampaign: (b) => request(ws('/campaigns'), { method: 'POST', body: b }),
  updateCampaign: (id, b) => request(ws(`/campaigns/${id}`), { method: 'PUT', body: b }),
  sendCampaign: (id) => request(ws(`/campaigns/${id}/send`), { method: 'POST' }),
  campaignPreview: (id) => request(ws(`/campaigns/${id}/preview`)),
  campaignMessages: (id) => request(ws(`/campaigns/${id}/messages`))
};
