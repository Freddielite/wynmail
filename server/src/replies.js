import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { one, many, query } from './db.js';
import { decrypt } from './config.js';
import { suppress } from './suppress.js';
import { notify } from './notify.js';
import { resolvePublic, testMode } from './providers/smtp.js';

// Reads each sending mailbox's inbox (read only, nothing is marked read or moved) to find out what happened to the
// emails we sent: a real reply, someone asking to be removed, an out-of-office note, or a bounce message.
// A reply or a removal request stops any further automatic emails to that person at once.

export const POLL_SECONDS = Number(process.env.REPLY_POLL_SECONDS || 120);

export { imapHostFor } from './imaphost.js';

/* ---------- what a message is ---------- */
const AUTO_SUBJECT = /^\s*(auto(matic)?[- ]?reply|auto[- ]?response|autoreply|out of (the )?office|away from (the )?office|automatische antwort|auto:)/i;
const UNSUB = /\b(unsubscribe|un-subscribe|remove me|take me off|delete me|stop (emailing|sending|contacting|messaging)( me)?|do not (contact|email|send)( me)?|don'?t (contact|email|send)( me)?|opt[- ]?out|no more emails?)\b/i;

// The new text of a reply, without the quoted message below it.
export function topText(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line) || /^\s*(on .{5,120} wrote:|-{2,}\s*(original message|forwarded)|from:\s.+|sent from my )/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

const header = (parsed, name) => {
  const v = parsed.headers?.get(name);
  return v === undefined ? '' : typeof v === 'string' ? v : v?.value ? [].concat(v.value).map((x) => x.address || x).join(' ') : String(v);
};

export function classify(parsed) {
  const from = (parsed.from?.value?.[0]?.address || '').toLowerCase();
  const subject = parsed.subject || '';
  const ct = String(header(parsed, 'content-type') || parsed.headers?.get('content-type')?.value || '');
  const dsn = (parsed.attachments || []).find((a) => /message\/delivery-status/i.test(a.contentType));
  if (dsn || /report-type=delivery-status/i.test(JSON.stringify(parsed.headers?.get('content-type') || ct)) || /^(mailer-daemon|postmaster)@/i.test(from)) {
    const text = dsn ? dsn.content.toString('utf8') : String(parsed.text || '');
    const recipient = (text.match(/(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*<?([^\s<>;]+@[^\s<>;]+)/i) || text.match(/\b([\w.+'-]+@[\w.-]+\.[a-z]{2,})\b/i) || [])[1]?.toLowerCase() || null;
    const status = text.match(/^Status:\s*(\d\.\d+\.\d+)/im)?.[1] || text.match(/\b([45]\.\d{1,3}\.\d{1,3})\b/)?.[1] || null;
    const action = text.match(/^Action:\s*(\w+)/im)?.[1]?.toLowerCase() || null;
    const original = (parsed.attachments || []).find((a) => /message\/rfc822|text\/rfc822-headers/i.test(a.contentType));
    const hay = original ? original.content.toString('utf8') : String(parsed.text || '');
    const originalId = hay.match(/^Message-ID:\s*(<[^>\s]+>)/im)?.[1] || null;
    const hard = action === 'delayed' ? false : (status ? status.startsWith('5') : action === 'failed');
    return { kind: 'bounce', recipient, hard, status, originalId };
  }
  const autoSub = String(header(parsed, 'auto-submitted')).toLowerCase();
  const prec = String(header(parsed, 'precedence')).toLowerCase();
  if ((autoSub && autoSub !== 'no') || header(parsed, 'x-autoreply') || header(parsed, 'x-autorespond') || /auto_reply|auto-reply|bulk|junk/.test(prec) || AUTO_SUBJECT.test(subject)) {
    return { kind: 'auto_reply' };
  }
  const top = topText(parsed.text);
  if (top.length <= 400 && UNSUB.test(top)) return { kind: 'unsubscribe' };
  return { kind: 'reply' };
}

const idsOf = (parsed) => [...new Set([].concat(parsed.inReplyTo || [], parsed.references || []).flatMap((x) => String(x).match(/<[^>\s]+>/g) || []))];

/* ---------- acting on it ---------- */
// Stops everything automatic for a prospect. A person who answered, asked to stop, or bounced hears nothing more.
export async function stopOutreach(contactId, reason) {
  await query(`UPDATE automation_runs SET status = 'cancelled', next_at = NULL, ended_reason = $2 WHERE contact_id = $1 AND status = 'active'`, [contactId, reason]);
  await query(`UPDATE messages SET status = 'skipped', error = $2 WHERE contact_id = $1 AND status IN ('queued', 'paused', 'held')`, [contactId, `Stopped: ${reason}`]);
}

async function findMessage(workspaceId, box, parsed, c) {
  const ids = c.kind === 'bounce' ? [c.originalId].filter(Boolean) : idsOf(parsed);
  if (ids.length) {
    const m = await one(`SELECT * FROM messages WHERE workspace_id = $1 AND provider_id = ANY($2::text[]) ORDER BY id DESC LIMIT 1`, [workspaceId, ids]);
    if (m) return m;
  }
  // Some providers rewrite the message id, so fall back to the address: who we emailed from this mailbox in the last 90 days.
  const email = c.kind === 'bounce' ? c.recipient : (parsed.from?.value?.[0]?.address || '').toLowerCase();
  if (!email) return null;
  return one(
    `SELECT * FROM messages WHERE workspace_id = $1 AND lower(email) = $2 AND sent_at IS NOT NULL AND sent_at > now() - interval '90 days' AND (mailbox_id = $3 OR mailbox_id IS NULL)
     ORDER BY sent_at DESC LIMIT 1`, [workspaceId, email, box.id]);
}

// Handles one incoming message. Returns the kind it recorded, or null when it has nothing to do with our emails.
export async function handleIncoming(box, parsed, uidKey) {
  const workspaceId = box.workspace_id;
  const headerId = (parsed.messageId || uidKey).slice(0, 300);
  if (await one(`SELECT 1 FROM replies WHERE workspace_id = $1 AND header_id = $2`, [workspaceId, headerId])) return null;
  const from = (parsed.from?.value?.[0]?.address || '').toLowerCase();
  if (from && (await one(`SELECT 1 FROM mailboxes WHERE workspace_id = $1 AND lower(from_email) = $2`, [workspaceId, from]))) return null; // our own mail

  const c = classify(parsed);
  const msg = await findMessage(workspaceId, box, parsed, c);
  if (!msg) return null;
  const contact = await one(`SELECT * FROM contacts WHERE id = $1`, [msg.contact_id]);
  if (!contact) return null;
  const prospect = contact.consent_source === 'prospector';
  const snippet = (c.kind === 'bounce' ? `Delivery failed${c.status ? ` (${c.status})` : ''}` : topText(parsed.text)).replace(/\s+/g, ' ').slice(0, 300);
  const when = parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : new Date();

  const ins = await one(
    `INSERT INTO replies (workspace_id, mailbox_id, contact_id, message_id, kind, from_email, subject, snippet, header_id, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING RETURNING id`,
    [workspaceId, box.id, contact.id, msg.id, c.kind === 'bounce' && !c.hard ? 'bounce_soft' : c.kind, c.kind === 'bounce' ? contact.email : from, String(parsed.subject || '').slice(0, 200), snippet, headerId, when]);
  if (!ins) return null;

  if (c.kind === 'reply') {
    await query(`UPDATE messages SET replied_at = COALESCE(replied_at, $2) WHERE id = $1`, [msg.id, when]);
    await query(`UPDATE contacts SET replied_at = COALESCE(replied_at, $2), tags = CASE WHEN 'replied' = ANY(tags) OR cardinality(tags) >= 50 THEN tags ELSE array_append(tags, 'replied') END WHERE id = $1`, [contact.id, when]);
    await query(`INSERT INTO events (workspace_id, message_id, type) VALUES ($1, $2, 'reply')`, [workspaceId, msg.id]);
    if (prospect) await stopOutreach(contact.id, 'replied');
    const who = contact.attributes?.company ? `${contact.attributes.company} (${contact.email})` : contact.email;
    await notify(workspaceId, { kind: 'reply', title: `Reply from ${who}`, body: snippet || 'They replied. Open your mailbox to answer.', path: '/replies' });
  } else if (c.kind === 'unsubscribe') {
    await query(`UPDATE contacts SET status = 'unsubscribed', unsubscribed_at = now() WHERE id = $1 AND status = 'subscribed'`, [contact.id]);
    await stopOutreach(contact.id, 'unsubscribed');
    await notify(workspaceId, { kind: 'reply', title: `${contact.email} asked to be removed`, body: `They were unsubscribed and will not be emailed again. They wrote: ${snippet}`, path: '/replies' });
  } else if (c.kind === 'bounce' && c.hard) {
    await query(`UPDATE messages SET bounced_at = COALESCE(bounced_at, now()), bounce_type = 'Permanent' WHERE id = $1`, [msg.id]);
    await query(`INSERT INTO events (workspace_id, message_id, type, meta) VALUES ($1, $2, 'bounce', $3)`, [workspaceId, msg.id, JSON.stringify({ type: 'Permanent', via: 'mailbox' })]);
    await suppress(workspaceId, contact.email, 'bounced');
    await stopOutreach(contact.id, 'bounced');
  }
  return c.kind === 'bounce' && !c.hard ? 'bounce_soft' : c.kind;
}

/* ---------- reading a mailbox ---------- */
const FRIENDLY = (err) => {
  if (err?.authenticationFailed || /auth|login|credentials/i.test(String(err?.message))) return 'Could not sign in to read replies. Turn on IMAP in the mailbox settings and use the same app password.';
  if (/enotfound|econnrefused|etimedout|timeout/i.test(`${err?.code} ${err?.message}`)) return 'Could not reach the mail server to read replies.';
  return `Could not read replies: ${String(err?.message || err).slice(0, 150)}`;
};

// The real connection. Tests swap this for a fake.
export async function openImap(box) {
  const host = box.imap_host;
  const ip = await resolvePublic(host);
  const client = new ImapFlow({ host: ip, port: 993, secure: true, auth: { user: box.username, pass: decrypt(box.password_enc) }, logger: false, socketTimeout: 60000,
    tls: { servername: host, rejectUnauthorized: !testMode() } });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  return {
    uidValidity: Number(client.mailbox.uidValidity),
    uidNext: Number(client.mailbox.uidNext),
    uidsSince: async (date) => (await client.search({ since: date }, { uid: true })) || [],
    uidsAfter: async (uid) => ((await client.search({ uid: `${uid + 1}:*` }, { uid: true })) || []).filter((u) => u > uid),
    async *fetch(uids) { for await (const m of client.fetch(uids.join(','), { source: { maxLength: 250000 }, uid: true }, { uid: true })) yield { uid: m.uid, source: m.source }; },
    async close() { lock.release(); await client.logout().catch(() => {}); }
  };
}

export async function pollMailbox(box, { open = openImap } = {}) {
  let conn;
  const stats = { checked: 0, reply: 0, unsubscribe: 0, auto_reply: 0, bounce: 0, bounce_soft: 0 };
  try {
    conn = await open(box);
    let uids;
    if (box.imap_last_uid && Number(box.imap_uidvalidity) === conn.uidValidity) uids = await conn.uidsAfter(Number(box.imap_last_uid));
    else uids = await conn.uidsSince(new Date(Date.now() - 7 * 86400000)); // first look (or the mailbox was reset): the last week
    uids = [...new Set(uids)].sort((a, b) => a - b).slice(0, 100);
    let last = uids.length ? uids[uids.length - 1] : (box.imap_last_uid && Number(box.imap_uidvalidity) === conn.uidValidity ? Number(box.imap_last_uid) : conn.uidNext - 1);
    if (uids.length) {
      for await (const m of conn.fetch(uids)) {
        stats.checked += 1;
        try {
          const kind = await handleIncoming(box, await simpleParser(m.source), `uid:${conn.uidValidity}:${m.uid}@${box.id}`);
          if (kind) stats[kind] += 1;
        } catch (err) { console.error(JSON.stringify({ level: 'error', msg: 'reply handling failed', mailbox: box.id, err: err.message })); }
      }
    }
    await query(`UPDATE mailboxes SET imap_uidvalidity = $2, imap_last_uid = $3, imap_checked_at = now(), imap_error = NULL WHERE id = $1`, [box.id, conn.uidValidity, Math.max(0, last)]);
    return { ok: true, ...stats };
  } catch (err) {
    await query(`UPDATE mailboxes SET imap_checked_at = now(), imap_error = $2 WHERE id = $1`, [box.id, FRIENDLY(err)]);
    return { ok: false, error: FRIENDLY(err), ...stats };
  } finally { await conn?.close().catch(() => {}); }
}

// Checks every mailbox that is due. Safe to run on several servers: a mailbox is claimed by moving its check time forward.
export async function pollDue(deps = {}) {
  const due = await many(
    `UPDATE mailboxes SET imap_checked_at = now() WHERE id IN (
       SELECT id FROM mailboxes WHERE enabled AND watch_replies AND imap_host IS NOT NULL
         AND (imap_checked_at IS NULL OR imap_checked_at < now() - ($1 || ' seconds')::interval) ORDER BY imap_checked_at NULLS FIRST LIMIT 20 FOR UPDATE SKIP LOCKED
     ) RETURNING *`, [String(POLL_SECONDS)]);
  for (const box of due) await pollMailbox(box, deps);
  return due.length;
}

export function startReplyWatcher() {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await pollDue(); } catch (err) { console.error(JSON.stringify({ level: 'error', msg: 'reply watcher', err: err.message })); } finally { busy = false; }
  }, 30000);
  timer.unref?.();
  return timer;
}
