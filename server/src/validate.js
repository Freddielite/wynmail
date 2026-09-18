export const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
export const isEmail = (e) => typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e);
export const normEmail = (e) => String(e ?? '').trim().toLowerCase();
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
export const TRACKING_RE = /^(https?:\/\/)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

export const cleanName = (s, max = 100) => String(s ?? '').replace(/[<>"\r\n]/g, '').trim().slice(0, max);
export const cleanText = (s, max = 500) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

export function cleanAttrs(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const out = {};
  for (const [k, v] of Object.entries(a).slice(0, 20)) {
    if (/^\w{1,40}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)) out[k] = String(v).slice(0, 300);
  }
  return out;
}

// A workspace may only send from its admin-approved sending domain.
// This stops one tenant spoofing another tenant's domain through the shared provider key.
export function senderAllowed(ws) {
  const domain = String(ws.sending_domain || '').toLowerCase();
  const email = String(ws.from_email || '').toLowerCase();
  if (!domain || !email.includes('@')) return false;
  const emailDomain = email.split('@')[1];
  return emailDomain === domain || emailDomain.endsWith('.' + domain);
}
