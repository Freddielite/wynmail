import crypto from 'crypto';
import express, { Router } from 'express';
import cors from 'cors';
import { one, query } from '../db.js';
import { hmac, safeEqual, decrypt } from '../config.js';
import { rateLimit } from '../rateLimit.js';
import { isEmail, normEmail, cleanName, senderAllowed } from '../validate.js';
import { upsertContact } from '../contacts.js';
import { getProvider } from '../providers/index.js';
import { throttled } from '../throttle.js';
import { sentToday } from '../usage.js';
import { trackingBase } from '../render.js';
import { actionEmail } from '../sysmail.js';
import { hashKey } from '../apikeys.js';
import { formPage, messagePage, esc } from '../pages.js';

const router = Router();
const urlencoded = express.urlencoded({ extended: false, limit: '20kb' });
const publicCors = cors({ origin: '*', methods: ['POST'] });
const perIp = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });
const perEmail = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, key: (req) => `${req.params.slug}|${normEmail(req.body?.email)}` });

// These pages carry their own CSP with a per-request nonce. Only the form page may be embedded elsewhere.
function pageHeaders(res, { embeddable }) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader('Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; img-src data:; frame-ancestors ${embeddable ? '*' : "'none'"}`);
  if (embeddable) res.removeHeader('X-Frame-Options'); else res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  return nonce;
}

const loadForm = (slug) => one(`SELECT * FROM forms WHERE slug = $1 AND active`, [String(slug).slice(0, 80)]);
const timeToken = (slug) => { const ts = Date.now(); return `${ts}.${hmac(`form:${slug}:${ts}`).slice(0, 24)}`; };

router.get('/f/:slug', async (req, res) => {
  const nonce = pageHeaders(res, { embeddable: true });
  const f = await loadForm(req.params.slug);
  if (!f) return res.status(404).type('html').send(messagePage('Form not found', 'This signup form does not exist or has been turned off.'));
  res.type('html').send(formPage({ f, t: timeToken(f.slug), embed: req.query.embed === '1', nonce }));
});

router.options('/f/:slug/subscribe', publicCors);

router.post('/f/:slug/subscribe', publicCors, perIp, urlencoded, perEmail, async (req, res) => {
  const wantsJson = req.is('application/json') || String(req.headers.accept || '').includes('application/json');
  const fail = (status, msg) => wantsJson
    ? res.status(status).json({ error: msg })
    : res.status(status).type('html').send(messagePage('Please check your details', esc(msg), { actionHtml: '<a class="btn" href="javascript:history.back()">Go back</a>' }));

  const f = await loadForm(req.params.slug);
  if (!f) return fail(404, 'This signup form is not available.');

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const email = normEmail(b.email);
  if (!isEmail(email)) return fail(400, 'Enter a valid email address.');
  if (!['on', 'true', '1', 'yes', true, 1].includes(b.consent)) return fail(400, 'Please tick the box to agree before subscribing.');

  // Bots get the same success answer as people, but nothing happens.
  let silent = String(b.website || '').trim() !== '';
  if (b.t !== undefined && !silent) {
    const [ts, sig] = String(b.t).split('.');
    const age = Date.now() - Number(ts);
    if (!sig || !safeEqual(sig, hmac(`form:${f.slug}:${ts}`).slice(0, 24))) silent = true;
    else if (age < 2000) return fail(400, 'That was quick. Please wait a moment and submit again.');
    else if (age > 24 * 3600 * 1000) return fail(400, 'This page has expired. Reload it and try again.');
  }

  const ok = () => {
    if (wantsJson) return res.json({ ok: true, message: f.success_message, redirect: f.redirect_url || null });
    return res.type('html').send(messagePage('Thank you', esc(f.success_message),
      { actionHtml: f.redirect_url ? `<a class="btn" href="${esc(f.redirect_url)}">Continue</a>` : '' }));
  };
  ok();
  if (silent) return;

  // Answer first, work after: the response is identical whether or not the address is already known.
  processSignup(f, {
    email, first_name: cleanName(b.first_name, 60) || null, last_name: cleanName(b.last_name, 60) || null,
    ip: String(req.ip || '').slice(0, 64), ua: String(req.headers['user-agent'] || '').slice(0, 200)
  }).catch((err) => console.error('[forms]', err.message));
});

async function processSignup(f, s) {
  if (!f.list_id) return;
  const ws = await one(`SELECT * FROM workspaces WHERE id = $1`, [f.workspace_id]);
  if (await one(`SELECT 1 FROM suppressions WHERE workspace_id = $1 AND email = $2`, [ws.id, s.email])) return;

  const existing = await one(`SELECT id, status FROM contacts WHERE workspace_id = $1 AND email = $2`, [ws.id, s.email]);
  if (existing && ['bounced', 'complained'].includes(existing.status)) return;
  if (existing?.status === 'subscribed'
    && (await one(`SELECT 1 FROM list_contacts WHERE list_id = $1 AND contact_id = $2`, [f.list_id, existing.id]))) return;

  // Someone who unsubscribed can only come back by confirming, even on a single opt-in form,
  // so a stranger cannot re-subscribe them.
  const needsConfirm = f.double_optin || existing?.status === 'unsubscribed';
  if (!needsConfirm) {
    const row = await one(
      `INSERT INTO form_signups (workspace_id, form_id, email, first_name, last_name, consent_text, ip, user_agent, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING *`,
      [ws.id, f.id, s.email, s.first_name, s.last_name, f.consent_text, s.ip, s.ua]);
    await finalize(row, f);
    return;
  }

  if (await one(`SELECT 1 FROM form_signups WHERE form_id = $1 AND email = $2 AND confirmed_at IS NULL AND created_at > now() - interval '10 minutes'`, [f.id, s.email])) return;

  const token = crypto.randomBytes(32).toString('base64url');
  const row = await one(
    `INSERT INTO form_signups (workspace_id, form_id, email, first_name, last_name, token_hash, consent_text, ip, user_agent, expires_at, email_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '48 hours', 'queued') RETURNING id`,
    [ws.id, f.id, s.email, s.first_name, s.last_name, hashKey(token), f.consent_text, s.ip, s.ua]);
  try {
    await sendConfirmation(f, ws, s.email, token);
    await query(`UPDATE form_signups SET email_status = 'sent' WHERE id = $1`, [row.id]);
  } catch (err) {
    await query(`UPDATE form_signups SET email_status = 'failed', email_error = $2 WHERE id = $1`, [row.id, String(err.message).slice(0, 300)]);
    console.error('[forms] confirmation email failed:', err.message);
  }
}

async function sendConfirmation(f, ws, email, token) {
  if (!senderAllowed(ws)) throw new Error('Sender not approved. Set a sending domain and from email in Settings.');
  if ((await sentToday(ws.id)) >= (ws.daily_limit || 0)) throw new Error('Daily sending limit reached.');
  const link = `${trackingBase(ws)}/confirm/${token}`;
  const { html, text } = actionEmail({
    heading: f.confirm_subject, body: f.confirm_body, label: 'Confirm subscription', url: link,
    note: `If you did not sign up, you can ignore this email.${ws.footer_address ? ' ' + ws.footer_address : ''}`
  });
  const provider = getProvider(ws);
  const rec = await one(`INSERT INTO api_emails (workspace_id, to_email, subject, kind) VALUES ($1, $2, $3, 'confirm') RETURNING id`, [ws.id, email, f.confirm_subject]);
  try {
    const result = await throttled(() => provider.send({
      to: email, from: `${ws.from_name || ws.name} <${ws.from_email}>`, replyTo: ws.reply_to || undefined,
      subject: f.confirm_subject, html, text, apiKey: decrypt(ws.provider_api_key) || undefined
    }));
    await query(`UPDATE api_emails SET status = 'sent', provider_id = $2 WHERE id = $1`, [rec.id, result.id || null]);
    if (provider.name === 'console') console.log('[confirm email]', email, '|', text.replace(/\s+/g, ' '));
  } catch (err) {
    await query(`UPDATE api_emails SET status = 'failed', error = $2 WHERE id = $1`, [rec.id, String(err.message).slice(0, 300)]);
    throw err;
  }
}

// Turns a confirmed signup into a subscribed contact with a consent record.
async function finalize(s, f) {
  const before = await one(`SELECT status FROM contacts WHERE workspace_id = $1 AND email = $2`, [s.workspace_id, s.email]);
  const contact = await upsertContact(s.workspace_id, { email: s.email, first_name: s.first_name, last_name: s.last_name, consent_source: `form:${f.slug}` }, f.list_id);
  if (before?.status === 'unsubscribed') {
    await query(
      `UPDATE contacts SET status = 'subscribed', unsubscribed_at = NULL, consent_source = $3, consent_at = now(),
         consent_text = $4, consent_ip = $5, consent_form_id = $6 WHERE id = $1 AND workspace_id = $2`,
      [contact.id, s.workspace_id, `form:${f.slug}`, s.consent_text, s.ip, f.id]);
  } else {
    await query(
      `UPDATE contacts SET consent_text = COALESCE(consent_text, $3), consent_ip = COALESCE(consent_ip, $4),
         consent_form_id = COALESCE(consent_form_id, $5) WHERE id = $1 AND workspace_id = $2`,
      [contact.id, s.workspace_id, s.consent_text, s.ip, f.id]);
  }
}

/* ---------- confirmation link ---------- */
// GET only shows a button, so mail scanners that open links cannot confirm anyone. POST confirms.
const TOKEN_RE = /^[\w-]{40,50}$/;
const pendingFor = (token) => TOKEN_RE.test(token)
  ? one(`SELECT s.*, f.title, f.slug, f.redirect_url, f.list_id, w.name AS ws_name FROM form_signups s
         JOIN forms f ON f.id = s.form_id JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.token_hash = $1 AND s.confirmed_at IS NULL AND s.expires_at > now()`, [hashKey(token)])
  : null;
const invalidPage = (res) => res.status(400).type('html').send(messagePage('Link not valid', 'This confirmation link has expired or was already used. You can sign up again.'));

router.get('/confirm/:token', async (req, res) => {
  pageHeaders(res, { embeddable: false });
  const s = await pendingFor(req.params.token);
  if (!s) return invalidPage(res);
  res.type('html').send(messagePage('Confirm your subscription', `Confirm that <strong>${esc(s.email)}</strong> should receive emails from ${esc(s.ws_name)}.`,
    { actionHtml: `<form method="post" action="/confirm/${esc(req.params.token)}"><button class="btn" type="submit">Confirm subscription</button></form>` }));
});

router.post('/confirm/:token', async (req, res) => {
  pageHeaders(res, { embeddable: false });
  if (!TOKEN_RE.test(req.params.token)) return invalidPage(res);
  const row = await one(
    `UPDATE form_signups SET confirmed_at = now() WHERE token_hash = $1 AND confirmed_at IS NULL AND expires_at > now() RETURNING *`,
    [hashKey(req.params.token)]);
  if (!row) return invalidPage(res);
  const f = await one(`SELECT * FROM forms WHERE id = $1`, [row.form_id]);
  if (f?.list_id) await finalize(row, f);
  res.type('html').send(messagePage('You are subscribed', 'Thank you. Your subscription is confirmed.',
    { actionHtml: f?.redirect_url ? `<a class="btn" href="${esc(f.redirect_url)}">Continue</a>` : '' }));
});

export default router;
