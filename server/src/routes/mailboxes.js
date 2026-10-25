import { Router } from 'express';
import { one } from '../db.js';
import { audit } from '../audit.js';
import { isEmail, normEmail, cleanText } from '../validate.js';
import { listMailboxes, createMailbox, updateMailbox, deleteMailbox, capacity, CAP_MIN, CAP_MAX, DEFAULT_CAP } from '../mailboxes.js';
import { verifyMailbox, smtpProviderFor, ALLOWED_PORTS, HOST_RE } from '../providers/smtp.js';

// Mailboxes the workspace sends through (Zoho Mail, Google Workspace...). Passwords are encrypted and never sent back.
const router = Router({ mergeParams: true });
const ws = (req) => req.workspace.id;
const bad = (res, msg) => res.status(400).json({ error: msg });
const MAX_BOXES = 10;
const testMode = () => process.env.SMTP_TEST_MODE === '1' && process.env.NODE_ENV !== 'production';

const sameDomain = (email, domain) => {
  const d = String(email).split('@')[1]?.toLowerCase(), want = String(domain || '').toLowerCase();
  return !!want && (d === want || d?.endsWith(`.${want}`));
};

// Reads and checks the fields. `current` is the saved mailbox when editing.
function read(b, workspace, current = null) {
  const out = {};
  if (b.label !== undefined) out.label = cleanText(b.label, 80);
  if (b.host !== undefined) {
    out.host = String(b.host).trim().toLowerCase();
    if (!HOST_RE.test(out.host) || out.host.length > 253) return { error: 'Enter the mail server, like smtp.zoho.com or smtp.gmail.com' };
  }
  if (b.port !== undefined) {
    out.port = Number(b.port);
    if (!Number.isInteger(out.port) || (!testMode() && !ALLOWED_PORTS.includes(out.port))) return { error: `Port must be one of ${ALLOWED_PORTS.join(', ')} (465 is the usual one for Zoho and Google)` };
  }
  if (b.username !== undefined) {
    out.username = String(b.username).trim();
    if (!out.username || out.username.length > 254) return { error: 'Enter the mailbox username (usually the full email address)' };
  }
  if (typeof b.password === 'string' && b.password) {
    if (b.password.length > 200) return { error: 'That password is too long' };
    out.password = b.password;
  }
  const from = b.from_email !== undefined ? normEmail(b.from_email) : (current ? undefined : normEmail(out.username));
  if (from !== undefined) {
    if (!isEmail(from)) return { error: 'The sending address must be a valid email' };
    if (!sameDomain(from, workspace.sending_domain)) return { error: `The sending address must be at ${workspace.sending_domain || 'your sending domain'}. Set the sending domain first.` };
    out.from_email = from;
  }
  if (b.daily_cap !== undefined) {
    out.daily_cap = Number(b.daily_cap);
    if (!Number.isInteger(out.daily_cap) || out.daily_cap < CAP_MIN || out.daily_cap > CAP_MAX) return { error: `Daily limit must be ${CAP_MIN} to ${CAP_MAX}` };
  }
  if (b.enabled !== undefined) out.enabled = b.enabled === true;
  return { value: out };
}

router.get('/', async (req, res) => res.json({
  mailboxes: await listMailboxes(ws(req)),
  capacity: await capacity(ws(req)),
  provider: req.workspace.provider,
  default_cap: DEFAULT_CAP, max_cap: CAP_MAX, ports: ALLOWED_PORTS
}));

router.post('/', async (req, res) => {
  const { value, error } = read({ daily_cap: DEFAULT_CAP, ...(req.body || {}) }, req.workspace);
  if (error) return bad(res, error);
  for (const k of ['host', 'port', 'username', 'password']) if (value[k] === undefined) return bad(res, 'Fill in the mail server, port, username and password');
  if ((await listMailboxes(ws(req))).length >= MAX_BOXES) return bad(res, `At most ${MAX_BOXES} mailboxes`);
  try { await verifyMailbox({ ...value }); } catch (err) { return res.status(400).json({ error: err.message, kind: err.kind }); }
  try {
    const box = await createMailbox(ws(req), { label: value.label || value.from_email, ...value });
    await audit(req, 'mailbox.created', { target: box.id, meta: { host: box.host, from_email: box.from_email, daily_cap: box.daily_cap } });
    res.json(box);
  } catch (err) {
    if (/unique|duplicate/i.test(err.message)) return res.status(409).json({ error: 'That mailbox is already added' });
    throw err;
  }
});

router.put('/:id', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return bad(res, 'bad id');
  const current = await one(`SELECT * FROM mailboxes WHERE id = $1 AND workspace_id = $2`, [req.params.id, ws(req)]);
  if (!current) return res.status(404).json({ error: 'not found' });
  const { value, error } = read(req.body || {}, req.workspace, current);
  if (error) return bad(res, error);
  // A new server, user or password is proven before it replaces the old one, so a typo cannot switch the mailbox off.
  const login = ['host', 'port', 'username', 'password'].some((k) => value[k] !== undefined);
  if (login) {
    const { decrypt } = await import('../config.js');
    try { await verifyMailbox({ host: current.host, port: current.port, username: current.username, from_email: current.from_email, ...value, password: value.password || decrypt(current.password_enc) }); }
    catch (err) { return res.status(400).json({ error: err.message, kind: err.kind }); }
  }
  const box = await updateMailbox(ws(req), current.id, { ...value, verified: login });
  await audit(req, 'mailbox.updated', { target: box.id, meta: { fields: Object.keys(value).filter((k) => k !== 'password'), password_changed: value.password !== undefined } });
  res.json(box);
});

router.delete('/:id', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return bad(res, 'bad id');
  const gone = await deleteMailbox(ws(req), req.params.id);
  if (!gone) return res.status(404).json({ error: 'not found' });
  await audit(req, 'mailbox.deleted', { target: gone.id });
  res.json({ ok: true });
});

// Sends one test email through this mailbox, to the signed-in person's own address only. Counts towards its daily limit.
router.post('/:id/test', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return bad(res, 'bad id');
  const me = await one(`SELECT email FROM users WHERE id = $1`, [req.user.uid]);
  try {
    const r = await smtpProviderFor(req.workspace, { only: Number(req.params.id) }).send({
      to: me.email, subject: 'Wynmail mailbox test',
      html: '<p>This mailbox is connected to Wynmail and can send.</p>', text: 'This mailbox is connected to Wynmail and can send.'
    });
    await audit(req, 'mailbox.test_sent', { target: req.params.id });
    res.json({ ok: true, sent_to: me.email, id: r.id });
  } catch (err) {
    if (err.kind === 'capacity') return res.status(409).json({ error: 'That mailbox has no sends left today, or it is switched off.' });
    res.status(400).json({ error: err.message, kind: err.kind });
  }
});

export default router;
