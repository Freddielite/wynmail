import crypto from 'crypto';
import { hmac } from './config.js';

export const newToken = () => crypto.randomBytes(16).toString('hex');

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Merge fields look like {{first_name}}. Values are HTML-escaped when merged into HTML,
// so a contact named <script> cannot inject markup into an email or a preview.
export function merge(input, contact, { html = false } = {}) {
  const data = { ...(contact.attributes || {}),
    first_name: contact.first_name || '', last_name: contact.last_name || '', email: contact.email || '' };
  // {{first_name}} or {{first_name|there}}: the text after the bar is used when the value is empty.
  return String(input || '').replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g, (_, key, fallback) => {
    let value = Object.hasOwn(data, key) && data[key] !== undefined && data[key] !== null ? String(data[key]) : '';
    if (value.trim() === '' && fallback !== undefined) value = fallback;
    return html ? escapeHtml(value) : value;
  });
}

export function trackingBase(workspace) {
  const domain = String(workspace.tracking_domain ?? '').trim();
  // An empty or stray "null" value falls back to the app URL instead of producing a dead link.
  if (domain && domain.toLowerCase() !== 'null') return domain.startsWith('http') ? domain : `https://${domain}`;
  return (process.env.PUBLIC_URL || 'http://localhost:4000').replace(/\/+$/, '');
}

export const linkSig = (token, url) => hmac(`c:${token}:${url}`).slice(0, 32);

// Every link is signed, so the click endpoint only redirects to URLs that Wynmail itself rendered.
export function rewriteLinks(html, base, token) {
  return html.replace(/href\s*=\s*"(https?:\/\/[^"]+)"/gi, (match, raw) => {
    if (raw.includes('/t/u/')) return match;
    const url = raw.replace(/&amp;/g, '&');
    return `href="${base}/t/c/${token}?url=${encodeURIComponent(url)}&sig=${linkSig(token, url)}"`;
  });
}

export function complianceFooter(workspace, base, token) {
  const address = escapeHtml(workspace.footer_address || workspace.name || '');
  return `
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0;font:12px/1.6 Arial,sans-serif;color:#64748b;text-align:center">
    <div>${address}</div>
    <div style="margin-top:6px">
      <a href="${base}/t/u/${token}" style="color:#1d4ed8">Unsubscribe</a> from these emails.
    </div>
  </div>`;
}

const FOOTER_TOKEN = /\{\{\s*footer\s*\}\}/gi;
const FOOTER_MARK = '<!--wm-footer-->';

export function buildEmail({ workspace, contact, subject, html, token, preheader = '' }) {
  const base = trackingBase(workspace);
  // Designed emails put {{footer}} where the unsubscribe footer belongs. Everything else gets it at the end.
  const hasToken = new RegExp(FOOTER_TOKEN.source, 'i').test(String(html || ''));
  const marked = String(html || '').replace(FOOTER_TOKEN, FOOTER_MARK);
  let body = merge(marked, contact, { html: true });
  body = rewriteLinks(body, base, token);
  const footer = complianceFooter(workspace, base, token);
  if (hasToken) {
    const first = body.indexOf(FOOTER_MARK);
    body = body.slice(0, first) + footer + body.slice(first + FOOTER_MARK.length).split(FOOTER_MARK).join('');
  } else {
    body += footer;
  }
  body += `<img src="${base}/t/o/${token}.png" width="1" height="1" alt="" style="display:none">`;
  // The preview text inboxes show after the subject. Hidden in the email itself, padded so body text does not leak in.
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(merge(preheader, contact))}${'&nbsp;&zwnj;'.repeat(90)}</div>`
    : '';
  return {
    subject: merge(subject, contact).replace(/[\r\n]+/g, ' ').slice(0, 300),
    html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc">${pre}${body}</body></html>`,
    text: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    headers: {
      'List-Unsubscribe': `<${base}/t/u/${token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  };
}
