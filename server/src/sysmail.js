import { getProvider } from './providers/index.js';

// Account emails (password reset, team invites). Sent from SYSTEM_FROM through the shared Resend key.
export async function sendSystemEmail({ to, subject, html, text }) {
  const from = process.env.SYSTEM_FROM || 'Wynmail <onboarding@resend.dev>';
  const provider = getProvider({ provider: 'resend' });
  if (provider.name === 'console') console.log('[system email]', to, '|', subject, '|', text.replace(/\s+/g, ' '));
  return provider.send({ to, from, subject, html, text });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function actionEmail({ heading, body, label, url, note }) {
  const html = `<div style="font:15px/1.6 Arial,sans-serif;color:#0f172a;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 12px;color:#0b2a5b">${esc(heading)}</h2>
  <p style="margin:0 0 20px">${esc(body)}</p>
  <p style="margin:0 0 20px"><a href="${esc(url)}" style="background:#1d4ed8;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;display:inline-block">${esc(label)}</a></p>
  <p style="margin:0;color:#64748b;font-size:13px">${esc(note)}</p></div>`;
  const text = `${heading}\n\n${body}\n\n${label}: ${url}\n\n${note}`;
  return { html, text };
}
