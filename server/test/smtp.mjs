// SMTP mailbox sending: real nodemailer talking to a real local SMTP server (STARTTLS, auth, rejections).
// Covers login checks, rotation, daily caps, auth lockout protection, refused recipients, and the send queue.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { SMTPServer } from 'smtp-server';
process.env.USE_PGLITE = '1';
process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-'));
process.env.SMTP_TEST_MODE = '1';
process.env.MX_CHECK = 'off';
delete process.env.FORCE_PROVIDER;
process.env.QUEUE_TICK_MS = '6000';
const { migrate, query, one, many } = await import('../src/db.js');
const M = await import('../src/mailboxes.js');
const S = await import('../src/providers/smtp.js');
const { getProvider } = await import('../src/providers/index.js');
const { enqueueCampaign, drainOnce } = await import('../src/queue.js');
const { encrypt } = await import('../src/config.js');
await migrate();

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 2 -subj "/CN=localhost" 2>/dev/null`);
const inbox = [];
let sawTls = 0;
const server = new SMTPServer({
  key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`), authMethods: ['PLAIN', 'LOGIN'], disabledCommands: [],
  onSecure(socket, session, cb) { sawTls += 1; cb(); },
  onAuth(auth, session, cb) { return auth.password === 'app-pass' ? cb(null, { user: auth.username }) : cb(Object.assign(new Error('Invalid login'), { responseCode: 535 })); },
  onRcptTo(addr, session, cb) { return /^nobody@/.test(addr.address) ? cb(Object.assign(new Error('User unknown'), { responseCode: 550 })) : cb(); },
  onData(stream, session, cb) { let raw = ''; stream.on('data', (c) => { raw += c; }); stream.on('end', () => { inbox.push({ user: session.user, raw }); cb(); }); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.server.address().port;
const hdr = (raw, name) => raw.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'))?.[1];
const base = { host: '127.0.0.1', port: PORT, from_email: 'one@t.ng' };

/* ---------- logging in ---------- */
check('a correct login is accepted, over STARTTLS', await S.verifyMailbox({ ...base, username: 'one@t.ng', password: 'app-pass' }).then(() => true, () => false) && sawTls >= 1);
check('a wrong password is explained (app password hint)', await S.verifyMailbox({ ...base, username: 'one@t.ng', password: 'nope' }).then(() => null, (e) => e).then((e) => e?.kind === 'auth' && /app password/.test(e.message)));
check('a closed port is a network error', await S.verifyMailbox({ ...base, port: 1, username: 'a', password: 'b' }).then(() => null, (e) => e).then((e) => e?.kind === 'network'));
process.env.SMTP_TEST_MODE = '0';
check('outside test mode a private server address is refused', await S.verifyMailbox({ ...base, username: 'a', password: 'b' }).then(() => null, (e) => e).then((e) => e?.kind === 'blocked'));
check('so is localhost by name', await S.verifyMailbox({ ...base, host: 'localhost', username: 'a', password: 'b' }).then(() => null, (e) => e).then((e) => e?.kind === 'blocked'));
process.env.SMTP_TEST_MODE = '1';
check('only the usual mail ports are allowed', JSON.stringify(S.ALLOWED_PORTS) === '[465,587,2525]' && S.HOST_RE.test('smtp.zoho.com') && !S.HOST_RE.test('nodots') && !S.HOST_RE.test('a b.com'));

/* ---------- a workspace with two mailboxes ---------- */
const ws = await one(`INSERT INTO workspaces (name, slug, from_name, from_email, sending_domain, footer_address, provider) VALUES ('Wyntek', 'wyn', 'Wyntek', 'one@t.ng', 't.ng', 'Abuja', 'smtp') RETURNING *`);
const mk = (n, cap = 30, extra = {}) => M.createMailbox(ws.id, { label: n, host: '127.0.0.1', port: PORT, username: `${n}@t.ng`, password: 'app-pass', from_email: `${n}@t.ng`, daily_cap: cap, ...extra });
const one1 = await mk('one', 2), two = await mk('two', 1);
check('passwords are stored encrypted and never listed', !JSON.stringify(await M.listMailboxes(ws.id)).includes('app-pass') && (await one(`SELECT password_enc FROM mailboxes WHERE id = $1`, [one1.id])).password_enc.startsWith('v1:'));
check('capacity is the sum of the caps', JSON.stringify(await M.capacity(ws.id)) === '{"boxes":2,"left":3}');

const msg = (to, n = 1) => ({ to, subject: `Hello ${n}`, html: `<p>Hi ${n}</p>`, text: `Hi ${n}`, headers: { 'List-Unsubscribe': '<https://t.ng/u/abc>', 'X-Test': 'yes' }, replyTo: 'reply@t.ng' });
const provider = getProvider(ws);
check('the workspace chooses the SMTP provider', provider.name === 'smtp');
const r1 = await provider.send(msg('a@x.com', 1)), r2 = await provider.send(msg('b@x.com', 2));
check('sends alternate between mailboxes', r1.mailboxId !== r2.mailboxId && new Set([r1.mailboxId, r2.mailboxId]).size === 2);
const m1 = inbox[0].raw;
check('the email goes out as the mailbox, with the workspace name', /^From: "?Wyntek"? <(one|two)@t\.ng>/im.test(m1), hdr(m1, 'From'));
check('headers and reply-to survive', hdr(m1, 'List-Unsubscribe') === '<https://t.ng/u/abc>' && hdr(m1, 'X-Test') === 'yes' && /reply@t\.ng/.test(hdr(m1, 'Reply-To')));
check('it is a proper multipart email with a message id on our domain', /multipart\/alternative/.test(m1) && /@t\.ng>/.test(hdr(m1, 'Message-ID')) && r1.id.endsWith('@t.ng>'));
check('the mailbox user that logged in matches', inbox.every((x) => /@t\.ng$/.test(x.user)));

/* ---------- daily caps ---------- */
await provider.send(msg('c@x.com', 3));
check('each mailbox stops at its own cap', (await M.listMailboxes(ws.id)).map((b) => `${b.sent_today}/${b.daily_cap}`).sort().join() === '1/1,2/2');
check('nothing left today', (await M.capacity(ws.id)).left === 0);
check('then sending is refused clearly, without touching the server', await provider.send(msg('d@x.com', 4)).then(() => null, (e) => e).then((e) => e?.kind === 'capacity') && inbox.length === 3);
await query(`UPDATE mailboxes SET sent_day = (now() AT TIME ZONE 'UTC')::date - 1`);
check('the next day the caps reset', (await M.capacity(ws.id)).left === 3 && (await M.listMailboxes(ws.id)).every((b) => b.sent_today === 0));

/* ---------- failures ---------- */
const dead = await mk('dead', 5, { port: 1 });
await query(`UPDATE mailboxes SET enabled = false WHERE id <> $1`, [dead.id]);
const e1 = await provider.send(msg('e@x.com')).then(() => null, (e) => e);
check('an unreachable server fails as a network problem', e1?.kind === 'network');
check('a send that never reached the server gives its slot back', (await one(`SELECT sent_today FROM mailboxes WHERE id = $1`, [dead.id])).sent_today === 0);
check('the problem is shown on the mailbox but it stays on', (await one(`SELECT last_error, enabled FROM mailboxes WHERE id = $1`, [dead.id])).enabled === true);
await M.deleteMailbox(ws.id, dead.id);
await query(`UPDATE mailboxes SET enabled = true`);
await query(`UPDATE mailboxes SET password_enc = $2 WHERE id = $1`, [two.id, encrypt('wrong')]);
await query(`UPDATE mailboxes SET last_used_at = NULL WHERE id = $1`, [two.id]);
const e2 = await provider.send(msg('f@x.com')).then(() => null, (e) => e);
check('a wrong password is an auth failure', e2?.kind === 'auth');
check('and the mailbox is switched off at once, so the provider never locks the account', (await one(`SELECT enabled, last_error FROM mailboxes WHERE id = $1`, [two.id])).enabled === false);
const ok = await provider.send(msg('g@x.com'));
check('the other mailbox carries on', ok.mailboxId === one1.id);
const e3 = await provider.send(msg('nobody@x.com')).then(() => null, (e) => e);
check('an address the recipient server refuses is reported as such', e3?.kind === 'recipient');
await query(`UPDATE mailboxes SET password_enc = $2, enabled = true, sent_today = 0 WHERE id = $1`, [two.id, encrypt('app-pass')]);

/* ---------- the send queue ---------- */
await query(`UPDATE mailboxes SET sent_today = 0, daily_cap = 2`);
const list = await one(`INSERT INTO lists (workspace_id, name) VALUES ($1, 'L') RETURNING id`, [ws.id]);
const emails = ['p1@x.com', 'p2@x.com', 'p3@x.com', 'nobody@x.com', 'p5@x.com', 'p6@x.com'];
for (const e of emails) {
  const c = await one(`INSERT INTO contacts (workspace_id, email) VALUES ($1, $2) RETURNING id`, [ws.id, e]);
  await query(`INSERT INTO list_contacts (list_id, contact_id) VALUES ($1, $2)`, [list.id, c.id]);
}
const camp = await one(`INSERT INTO campaigns (workspace_id, name, subject, html, list_id, status) VALUES ($1, 'C', 'Our March newsletter', '<p>Hello, here is what we shipped this month with every detail of the changes we made to the editor.</p><a href="https://t.ng/news">Read more</a>', $2, 'draft') RETURNING id`, [ws.id, list.id]);
await query(`UPDATE mailboxes SET enabled = false WHERE workspace_id = $1`, [ws.id]);
check('a campaign will not start with no mailbox switched on', await enqueueCampaign(camp.id).then(() => false, (e) => /mailbox/i.test(e.message)));
await query(`UPDATE mailboxes SET enabled = true WHERE workspace_id = $1`, [ws.id]);
inbox.length = 0;
check('with mailboxes on, the campaign queues everyone', (await enqueueCampaign(camp.id)) === 6);
await drainOnce(); await drainOnce(); await drainOnce();
const st = async () => Object.fromEntries((await many(`SELECT status, count(*)::int AS n FROM messages WHERE campaign_id = $1 GROUP BY status`, [camp.id])).map((r) => [r.status, r.n]));
let s = await st();
check('only what the mailboxes can send goes out today, the rest waits', s.sent === 3 && s.queued === 2 && s.failed === 1, JSON.stringify(s));
check('waiting messages use no attempts', (await one(`SELECT max(attempts)::int AS a FROM messages WHERE campaign_id = $1 AND status = 'queued'`, [camp.id])).a === 0);
check('the message records which mailbox sent it', (await many(`SELECT mailbox_id FROM messages WHERE campaign_id = $1 AND status = 'sent'`, [camp.id])).every((m) => m.mailbox_id));
check('a refused address is a hard bounce: marked, suppressed, contact stopped', (await one(`SELECT bounce_type FROM messages WHERE campaign_id = $1 AND status = 'failed'`, [camp.id])).bounce_type === 'Permanent'
  && !!(await one(`SELECT 1 FROM suppressions WHERE workspace_id = $1 AND email = 'nobody@x.com'`, [ws.id])) && (await one(`SELECT status FROM contacts WHERE email = 'nobody@x.com'`)).status === 'bounced');
check('the campaign is not marked finished while people still wait', (await one(`SELECT status FROM campaigns WHERE id = $1`, [camp.id])).status === 'sending');
await query(`UPDATE mailboxes SET sent_day = (now() AT TIME ZONE 'UTC')::date - 1`);
await drainOnce(); await drainOnce();
s = await st();
check('the next day the rest goes out', s.sent === 5 && !s.queued, JSON.stringify(s));
await drainOnce();
check('and the campaign finishes', (await one(`SELECT status FROM campaigns WHERE id = $1`, [camp.id])).status === 'sent');
check('every email arrived once, each from a mailbox of the workspace', inbox.length === 5 && inbox.every((x) => /@t\.ng$/.test(x.user)));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
