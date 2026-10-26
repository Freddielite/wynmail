// Replies, bounces and removal requests read from a mailbox; stopping outreach; the 3-email cap and spacing; starting sequences.
import fs from 'fs';
import os from 'os';
import path from 'path';
process.env.USE_PGLITE = '1';
process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'replies-'));
process.env.FORCE_PROVIDER = 'console';
process.env.QUEUE_TICK_MS = '60000';
const { migrate, query, one, many } = await import('../src/db.js');
const R = await import('../src/replies.js');
const { drainOnce, MAX_COLD_EMAILS, MIN_GAP_HOURS } = await import('../src/queue.js');
const { processDueRuns, startManual } = await import('../src/automations.js');
const O = await import('../src/outreach.js');
const { simpleParser } = await import('mailparser');
const { encrypt } = await import('../src/config.js');
await migrate();

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

/* ---------- reading messages ---------- */
const raw = (headers, body, extra = '') => `${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\nMIME-Version: 1.0\r\n${extra}\r\n${body}`;
const mail = (o) => simpleParser(raw({ From: o.from || 'Ada <ada@acme.ng>', To: 'hello@getwyntek.com', Subject: o.subject || 'Re: A quick idea', Date: 'Mon, 26 Oct 2026 09:00:00 +0000', 'Message-ID': o.id || '<r1@acme.ng>', ...(o.inReplyTo ? { 'In-Reply-To': o.inReplyTo, References: o.inReplyTo } : {}), ...(o.headers || {}) },
  o.body ?? 'Yes, tell me more.', 'Content-Type: text/plain; charset=utf-8\r\n'));
check('a normal answer is a reply', R.classify(await mail({ inReplyTo: '<a@x>' })).kind === 'reply');
check('the quoted message below the answer is ignored', R.topText('Sounds good.\n\nOn Mon, 26 Oct 2026, Wyntek wrote:\n> We build sites\n> please unsubscribe') === 'Sounds good.');
check('"please remove me" is a removal request', R.classify(await mail({ body: 'Please remove me from your list.\n\n> original' })).kind === 'unsubscribe' && R.classify(await mail({ body: 'STOP emailing me' })).kind === 'unsubscribe' && R.classify(await mail({ body: 'unsubscribe' })).kind === 'unsubscribe');
check('a long reply that mentions the word is still a reply', R.classify(await mail({ body: 'We might unsubscribe from other vendors but your offer is interesting. '.repeat(10) })).kind === 'reply');
check('out-of-office notes are not replies', R.classify(await mail({ headers: { 'Auto-Submitted': 'auto-replied' } })).kind === 'auto_reply'
  && R.classify(await mail({ subject: 'Automatic reply: A quick idea' })).kind === 'auto_reply' && R.classify(await mail({ subject: 'Out of Office', body: 'I am away' })).kind === 'auto_reply'
  && R.classify(await mail({ headers: { Precedence: 'bulk' } })).kind === 'auto_reply');
const dsn = (status, action, id) => simpleParser(`From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>\r\nTo: hello@getwyntek.com\r\nSubject: Delivery Status Notification (Failure)\r\nMessage-ID: <dsn${status}@google>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain\r\n\r\nYour message could not be delivered.\r\n\r\n--b1\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; googlemail.com\r\n\r\nFinal-Recipient: rfc822; gone@acme.ng\r\nAction: ${action}\r\nStatus: ${status}\r\nDiagnostic-Code: smtp; 550 user unknown\r\n\r\n--b1\r\nContent-Type: message/rfc822\r\n\r\nFrom: hello@getwyntek.com\r\nTo: gone@acme.ng\r\nMessage-ID: ${id}\r\nSubject: A quick idea\r\n\r\nhi\r\n\r\n--b1--\r\n`);
const hard = R.classify(await dsn('5.1.1', 'failed', '<orig1@getwyntek.com>'));
check('a failure notice is a hard bounce, with the address and the original message id', hard.kind === 'bounce' && hard.hard === true && hard.recipient === 'gone@acme.ng' && hard.originalId === '<orig1@getwyntek.com>' && hard.status === '5.1.1', JSON.stringify(hard));
check('a "still trying" notice is a soft bounce', R.classify(await dsn('4.2.2', 'delayed', '<o@x>')).hard === false);
check('a bounce with no machine-readable part is still recognised', R.classify(await simpleParser(raw({ From: 'mailer-daemon@zoho.com', To: 'a@b.c', Subject: 'Undelivered Mail Returned to Sender', 'Message-ID': '<z@z>' }, 'Final-Recipient: rfc822; nobody@acme.ng\r\nStatus: 5.1.1', 'Content-Type: text/plain\r\n'))).hard === true);

/* ---------- the database side ---------- */
const ws = await one(`INSERT INTO workspaces (name, slug, from_email, sending_domain, footer_address) VALUES ('Wyntek', 'wyn', 'hello@getwyntek.com', 'getwyntek.com', 'Abuja') RETURNING *`);
const box = await one(`INSERT INTO mailboxes (workspace_id, label, host, port, username, password_enc, from_email, imap_host) VALUES ($1, 'Main', 'smtp.zoho.com', 465, 'hello@getwyntek.com', $2, 'hello@getwyntek.com', 'imap.zoho.com') RETURNING *`, [ws.id, encrypt('pw')]);
await query(`INSERT INTO users (email, password_hash) VALUES ('boss@getwyntek.com', 'x')`);
await query(`INSERT INTO memberships (user_id, workspace_id, role) SELECT id, $1, 'owner' FROM users WHERE email = 'boss@getwyntek.com'`, [ws.id]);
const prospect = async (email, extra = {}) => one(`INSERT INTO contacts (workspace_id, email, consent_source, tags, attributes, status) VALUES ($1, $2, 'prospector', $3, $4, 'subscribed') RETURNING *`, [ws.id, email, extra.tags || ['prospect'], JSON.stringify(extra.attributes || { company: 'Acme Ltd' })]);
const sent = async (contact, id, agoHours = 30) => one(`INSERT INTO messages (workspace_id, contact_id, email, token, status, provider_id, mailbox_id, sent_at) VALUES ($1, $2, $3, $4, 'sent', $5, $6, now() - interval '1 hour' * $7) RETURNING *`, [ws.id, contact.id, contact.email, `t${Math.random()}`, id, box.id, agoHours]);
const queued = async (contact) => one(`INSERT INTO messages (workspace_id, contact_id, email, token, status) VALUES ($1, $2, $3, $4, 'queued') RETURNING *`, [ws.id, contact.id, contact.email, `q${Math.random()}`]);
const auto = await one(`INSERT INTO automations (workspace_id, name, status, trigger_type, goal_type, goal_value) VALUES ($1, 'Seq', 'active', 'manual', 'replied', '1') RETURNING *`, [ws.id]);
await query(`INSERT INTO automation_steps (automation_id, position, delay_minutes, kind, subject, html) VALUES ($1, 0, 0, 'email', 'One', '<p>One</p>'), ($1, 1, 4320, 'email', 'Two', '<p>Two</p>')`, [auto.id]);
const run = async (c) => one(`INSERT INTO automation_runs (automation_id, contact_id, current_step, next_at) VALUES ($1, $2, 1, now() + interval '3 days') RETURNING *`, [auto.id, c.id]);

const ada = await prospect('ada@acme.ng');
const adaSent = await sent(ada, '<orig-ada@getwyntek.com>');
const adaRun = await run(ada), adaNext = await queued(ada);
const parsedReply = await mail({ inReplyTo: '<orig-ada@getwyntek.com>', id: '<reply-ada@acme.ng>' });
check('a reply is matched to the email it answers', (await R.handleIncoming(box, parsedReply, 'uid:1')) === 'reply');
const adaAfter = await one(`SELECT * FROM contacts WHERE id = $1`, [ada.id]);
check('the person is marked as having replied and tagged', !!adaAfter.replied_at && adaAfter.tags.includes('replied') && !!(await one(`SELECT replied_at FROM messages WHERE id = $1`, [adaSent.id])).replied_at);
check('their sequence stops at once and waiting emails are cancelled', (await one(`SELECT status, ended_reason FROM automation_runs WHERE id = $1`, [adaRun.id])).ended_reason === 'replied' && (await one(`SELECT status FROM messages WHERE id = $1`, [adaNext.id])).status === 'skipped');
check('the owner is told, with what they wrote', (await one(`SELECT title, body FROM notifications WHERE kind = 'reply'`)).title.includes('Acme Ltd') && (await one(`SELECT body FROM notifications WHERE kind = 'reply'`)).body.includes('tell me more'));
check('it shows in the replies list', (await one(`SELECT kind, snippet, from_email FROM replies WHERE contact_id = $1`, [ada.id])).from_email === 'ada@acme.ng');
check('the same message is never counted twice', (await R.handleIncoming(box, parsedReply, 'uid:1')) === null && (await one(`SELECT count(*)::int AS n FROM replies`)).n === 1);

const ben = await prospect('ben@acme.ng'); await sent(ben, '<gmail-rewrote-this@mail.gmail.com>');
check('if the provider rewrote the message id, the sender address still matches', (await R.handleIncoming(box, await mail({ from: 'Ben <ben@acme.ng>', id: '<r-ben@acme.ng>', inReplyTo: '<something-else@x>' }), 'uid:2')) === 'reply' && !!(await one(`SELECT replied_at FROM contacts WHERE id = $1`, [ben.id])).replied_at);

const cy = await prospect('cy@acme.ng'); await sent(cy, '<orig-cy@getwyntek.com>'); const cyRun = await run(cy);
check('"remove me" unsubscribes them and stops everything', (await R.handleIncoming(box, await mail({ from: 'cy@acme.ng', id: '<r-cy@acme.ng>', inReplyTo: '<orig-cy@getwyntek.com>', body: 'Please remove me from your list.' }), 'uid:3')) === 'unsubscribe'
  && (await one(`SELECT status FROM contacts WHERE id = $1`, [cy.id])).status === 'unsubscribed' && (await one(`SELECT ended_reason FROM automation_runs WHERE id = $1`, [cyRun.id])).ended_reason === 'unsubscribed');

const dee = await prospect('dee@acme.ng'); await sent(dee, '<orig-dee@getwyntek.com>'); const deeRun = await run(dee);
check('an out-of-office note changes nothing', (await R.handleIncoming(box, await mail({ from: 'dee@acme.ng', id: '<ooo-dee@acme.ng>', inReplyTo: '<orig-dee@getwyntek.com>', headers: { 'Auto-Submitted': 'auto-replied' } }), 'uid:4')) === 'auto_reply'
  && !(await one(`SELECT replied_at FROM contacts WHERE id = $1`, [dee.id])).replied_at && (await one(`SELECT status FROM automation_runs WHERE id = $1`, [deeRun.id])).status === 'active');

const gone = await prospect('gone@acme.ng'); await sent(gone, '<orig1@getwyntek.com>'); const goneRun = await run(gone);
check('a hard bounce marks the email, stops the person and never emails them again', (await R.handleIncoming(box, await dsn('5.1.1', 'failed', '<orig1@getwyntek.com>'), 'uid:5')) === 'bounce'
  && (await one(`SELECT status FROM contacts WHERE id = $1`, [gone.id])).status === 'bounced' && !!(await one(`SELECT 1 FROM suppressions WHERE workspace_id = $1 AND email = 'gone@acme.ng'`, [ws.id]))
  && (await one(`SELECT bounce_type FROM messages WHERE provider_id = '<orig1@getwyntek.com>'`)).bounce_type === 'Permanent' && (await one(`SELECT ended_reason FROM automation_runs WHERE id = $1`, [goneRun.id])).ended_reason === 'bounced');
const slow = await prospect('slow@acme.ng'); await sent(slow, '<orig-slow@getwyntek.com>');
check('a soft bounce is only recorded', (await R.handleIncoming(box, await simpleParser((await dsn('4.2.2', 'delayed', '<orig-slow@getwyntek.com>')) && `From: mailer-daemon@googlemail.com\r\nSubject: Delayed\r\nMessage-ID: <soft1@g>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nFinal-Recipient: rfc822; slow@acme.ng\r\nAction: delayed\r\nStatus: 4.2.2\r\n`), 'uid:6')) === 'bounce_soft'
  && (await one(`SELECT status FROM contacts WHERE id = $1`, [slow.id])).status === 'subscribed');
check('mail from strangers is ignored', (await R.handleIncoming(box, await mail({ from: 'random@nowhere.com', id: '<r-x@x>' }), 'uid:7')) === null);
check('so is our own mail', (await R.handleIncoming(box, await mail({ from: 'hello@getwyntek.com', id: '<own@x>' }), 'uid:8')) === null);
const cust = await one(`INSERT INTO contacts (workspace_id, email, consent_source, status) VALUES ($1, 'cust@shop.ng', 'form', 'subscribed') RETURNING *`, [ws.id]);
await sent(cust, '<orig-cust@getwyntek.com>'); const custRun = await run(cust);
await R.handleIncoming(box, await mail({ from: 'cust@shop.ng', id: '<r-cust@x>', inReplyTo: '<orig-cust@getwyntek.com>' }), 'uid:9');
check('someone who signed up is recorded as replied but their sequence is not stopped', !!(await one(`SELECT replied_at FROM contacts WHERE id = $1`, [cust.id])).replied_at && (await one(`SELECT status FROM automation_runs WHERE id = $1`, [custRun.id])).status === 'active');

/* ---------- polling a mailbox (fake IMAP) ---------- */
const sources = { 101: raw({ From: 'Eve <eve@acme.ng>', To: 'hello@getwyntek.com', Subject: 'Re: hi', 'Message-ID': '<r-eve@acme.ng>', 'In-Reply-To': '<orig-eve@getwyntek.com>' }, 'Interested!', 'Content-Type: text/plain\r\n'),
  102: raw({ From: 'Spam <s@spam.com>', To: 'hello@getwyntek.com', Subject: 'Buy', 'Message-ID': '<sp@spam>' }, 'cheap', 'Content-Type: text/plain\r\n'),
  103: raw({ From: 'Fay <fay@acme.ng>', To: 'hello@getwyntek.com', Subject: 'Re: hi', 'Message-ID': '<r-fay@acme.ng>', 'In-Reply-To': '<orig-fay@getwyntek.com>' }, 'Call me', 'Content-Type: text/plain\r\n') };
const eve = await prospect('eve@acme.ng'); await sent(eve, '<orig-eve@getwyntek.com>');
const fay = await prospect('fay@acme.ng'); await sent(fay, '<orig-fay@getwyntek.com>');
let calls = [];
const fakeOpen = (validity = 7, have = [101, 102]) => async () => ({ uidValidity: validity, uidNext: 200,
  uidsSince: async () => { calls.push('since'); return have; }, uidsAfter: async (u) => { calls.push(`after ${u}`); return have.filter((x) => x > u); },
  async *fetch(uids) { for (const uid of uids) yield { uid, source: Buffer.from(sources[uid]) }; }, close: async () => {} });
let fresh = await one(`SELECT * FROM mailboxes WHERE id = $1`, [box.id]);
let res = await R.pollMailbox(fresh, { open: fakeOpen() });
check('the first look covers the last week and finds the reply', res.ok && res.checked === 2 && res.reply === 1 && calls[0] === 'since', JSON.stringify(res));
fresh = await one(`SELECT * FROM mailboxes WHERE id = $1`, [box.id]);
check('it remembers where it got to', Number(fresh.imap_last_uid) === 102 && Number(fresh.imap_uidvalidity) === 7 && !!fresh.imap_checked_at && fresh.imap_error === null);
calls = [];
res = await R.pollMailbox(fresh, { open: fakeOpen(7, [101, 102, 103]) });
check('next time it only reads what is new', calls[0] === 'after 102' && res.checked === 1 && res.reply === 1 && !!(await one(`SELECT replied_at FROM contacts WHERE id = $1`, [fay.id])).replied_at, JSON.stringify(res));
calls = [];
fresh = await one(`SELECT * FROM mailboxes WHERE id = $1`, [box.id]);
await R.pollMailbox(fresh, { open: fakeOpen(8, [101, 102, 103]) });
check('if the mailbox was reset it starts again, without double counting', calls[0] === 'since' && (await one(`SELECT count(*)::int AS n FROM replies WHERE from_email IN ('eve@acme.ng', 'fay@acme.ng')`)).n === 2);
res = await R.pollMailbox(fresh, { open: async () => { throw Object.assign(new Error('Invalid credentials'), { authenticationFailed: true }); } });
check('a login problem is shown in plain words and does not break sending', !res.ok && /Turn on IMAP/.test(res.error) && /Turn on IMAP/.test((await one(`SELECT imap_error FROM mailboxes WHERE id = $1`, [box.id])).imap_error) && (await one(`SELECT enabled FROM mailboxes WHERE id = $1`, [box.id])).enabled === true);
await query(`UPDATE mailboxes SET imap_checked_at = now() - interval '10 minutes'`);
check('mailboxes are checked on a schedule', (await R.pollDue({ open: fakeOpen(8, []) })) === 1 && (await R.pollDue({ open: fakeOpen(8, []) })) === 0);
await query(`UPDATE mailboxes SET watch_replies = false`);
await query(`UPDATE mailboxes SET imap_checked_at = now() - interval '10 minutes'`);
check('a mailbox with reply reading turned off is left alone', (await R.pollDue({ open: fakeOpen(8, []) })) === 0);
await query(`UPDATE mailboxes SET watch_replies = true`);

/* ---------- the rules at sending time ---------- */
check('the limits are 3 emails and 2 days by default', MAX_COLD_EMAILS === 3 && MIN_GAP_HOURS === 48);
const gus = await prospect('gus@acme.ng'); for (const h of [200, 150, 100]) await sent(gus, `<g${h}@x>`, h);
const gusMsg = await queued(gus);
const hal = await prospect('hal@acme.ng'); await query(`UPDATE contacts SET replied_at = now() WHERE id = $1`, [hal.id]); const halMsg = await queued(hal);
const ida = await prospect('ida@acme.ng'); await sent(ida, '<ida1@x>', 1); const idaMsg = await queued(ida);
const joe = await prospect('joe@acme.ng'); await sent(joe, '<joe1@x>', 60); const joeMsg = await queued(joe);
const kim = await one(`INSERT INTO contacts (workspace_id, email, consent_source, status) VALUES ($1, 'kim@shop.ng', 'form', 'subscribed') RETURNING *`, [ws.id]);
for (const h of [200, 150, 100, 1]) await sent(kim, `<k${h}@x>`, h); const kimMsg = await queued(kim);
await query(`INSERT INTO campaigns (workspace_id, name, subject, html, status) VALUES ($1, 'Seq', 'S', '<p>x</p>', 'sending')`, [ws.id]);
await query(`UPDATE messages SET campaign_id = (SELECT id FROM campaigns WHERE workspace_id = $1 LIMIT 1) WHERE id = ANY($2::int[])`, [ws.id, [gusMsg.id, halMsg.id, idaMsg.id, joeMsg.id, kimMsg.id]]);
await drainOnce();
const st = async (m) => one(`SELECT status, error, send_after, attempts FROM messages WHERE id = $1`, [m.id]);
check('a fourth email to a prospect is never sent', (await st(gusMsg)).status === 'skipped' && /at most 3/.test((await st(gusMsg)).error));
check('nothing is sent to someone who replied', (await st(halMsg)).status === 'skipped' && /replied/.test((await st(halMsg)).error));
const ids = await st(idaMsg);
check('two emails are never sent close together: it waits, using no attempt', ids.status === 'queued' && new Date(ids.send_after) - Date.now() > 45 * 3600000 && ids.attempts === 0, JSON.stringify(ids));
check('after enough time the next email goes out', (await st(joeMsg)).status === 'sent');
check('none of this applies to people who signed up', (await st(kimMsg)).status === 'sent');

/* ---------- starting a sequence ---------- */
const ws2 = await one(`INSERT INTO workspaces (name, slug) VALUES ('Second', 'second') RETURNING *`);
const plist = await one(`INSERT INTO lists (workspace_id, name, kind) VALUES ($1, 'Prospects', 'prospects') RETURNING id`, [ws2.id]);
const mk = async (email, o = {}) => { const c = await one(`INSERT INTO contacts (workspace_id, email, consent_source, tags, status, replied_at) VALUES ($1, $2, 'prospector', $3, $4, $5) RETURNING id`, [ws2.id, email, o.tags || ['prospect', 'role'], o.status || 'subscribed', o.replied || null]); await query(`INSERT INTO list_contacts (list_id, contact_id) VALUES ($1, $2)`, [plist.id, c.id]); return c; };
const info = await mk('info@zed.ng'), person = await mk('ada.obi@zed.ng', { tags: ['prospect', 'person'] }), rep = await mk('re@zed.ng', { replied: new Date() }), unsub = await mk('un@zed.ng', { status: 'unsubscribed' }), contacted = await mk('co@zed.ng');
await query(`INSERT INTO messages (workspace_id, contact_id, email, token, status, sent_at) VALUES ($1, $2, 'co@zed.ng', 'tok-co', 'sent', now())`, [ws2.id, contacted.id]);
const starter = await O.createStarter(ws2.id);
check('a starter sequence is paused and full of [EDIT] notes', starter.status === 'paused' && (await O.hasPlaceholders(starter.id)) && (await O.listSequences(ws2.id))[0].needs_editing === true);
check('it cannot be started while paused', await O.startOutreach(ws2.id, starter.id, 5).then(() => false, (e) => /switch/i.test(e.message)));
await query(`UPDATE automations SET status = 'active' WHERE id = $1`, [starter.id]);
check('or while it still has [EDIT] notes', await O.startOutreach(ws2.id, starter.id, 5).then(() => false, (e) => /EDIT/.test(e.message)));
await query(`UPDATE automation_steps SET subject = replace(subject, '[EDIT', 'x'), html = replace(html, '[EDIT', 'x') WHERE automation_id = $1`, [starter.id]);
const st0 = await O.outreachStats(ws2.id);
check('the numbers say where prospects stand', st0.total === 5 && st0.not_contacted === 2 && st0.replied === 1 && st0.removed === 1, JSON.stringify(st0));
check('a batch of 1 starts the named person first', (await O.startOutreach(ws2.id, starter.id, 1)).started === 1 && !!(await one(`SELECT 1 FROM automation_runs WHERE automation_id = $1 AND contact_id = $2`, [starter.id, person.id])));
check('the rest of the batch skips people who replied, left, or were already emailed', (await O.startOutreach(ws2.id, starter.id, 10)).started === 1 && !!(await one(`SELECT 1 FROM automation_runs WHERE automation_id = $1 AND contact_id = $2`, [starter.id, info.id]))
  && !(await one(`SELECT 1 FROM automation_runs WHERE automation_id = $1 AND contact_id IN ($2, $3, $4)`, [starter.id, rep.id, unsub.id, contacted.id])));
check('starting again enrols nobody twice', (await O.startOutreach(ws2.id, starter.id, 10)).started === 0);
await query(`UPDATE automation_runs SET next_at = now() - interval '1 minute' WHERE automation_id = $1`, [starter.id]);
await processDueRuns();
check('the sequence queues its first email for each', (await one(`SELECT count(*)::int AS n FROM messages WHERE automation_id = $1 AND status = 'queued'`, [starter.id])).n === 2);
await query(`UPDATE automation_runs SET next_at = now() - interval '1 minute' WHERE automation_id = $1`, [starter.id]);
await query(`UPDATE contacts SET replied_at = now() WHERE id = $1`, [info.id]);
await processDueRuns();
check('a prospect who replied in the meantime gets no second email', (await one(`SELECT ended_reason FROM automation_runs WHERE automation_id = $1 AND contact_id = $2`, [starter.id, info.id])).ended_reason === 'replied');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
