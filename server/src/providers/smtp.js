import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { decrypt } from '../config.js';
import { isPrivateIp } from '../safefetch.js';
import { claimMailbox, claimSpecific, releaseSlot, recordFailure, recordSuccess } from '../mailboxes.js';

// Sends through the workspace's own mailboxes over SMTP. Same contract as the other providers:
//   send({ to, subject, html, text, headers, replyTo }) -> { id, mailboxId }
// Test mode (SMTP_TEST_MODE=1, never in production) allows a local test server and a self-signed certificate.
const testMode = () => process.env.SMTP_TEST_MODE === '1' && process.env.NODE_ENV !== 'production';
export const ALLOWED_PORTS = [465, 587, 2525];

export const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// The server the user typed must be a public mail server. Resolved here and pinned, so a DNS trick cannot point us inward.
async function resolvePublic(host) {
  if (net.isIP(host)) { if (!testMode() && isPrivateIp(host)) throw smtpError('blocked', 'That mail server address is not allowed.'); return host; }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw smtpError('dns', `Could not find the mail server ${host}. Check the spelling.`); }
  if (!testMode() && (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))) throw smtpError('blocked', 'That mail server address is not allowed.');
  return addrs[0].address;
}

export function smtpError(kind, message, extra = {}) { return Object.assign(new Error(message), { kind, ...extra }); }

export function classify(err) {
  const c = err.responseCode;
  if (err.kind) return err;
  if (err.code === 'EAUTH' || c === 535 || c === 534) return smtpError('auth', 'The mailbox refused the username or password. Zoho and Google usually need an app password, not your normal one.');
  if (err.code === 'EENVELOPE' || (err.command === 'RCPT TO' && c >= 500 && c < 600)) return smtpError('recipient', `The recipient's server refused this address (${c || 'rejected'}).`);
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET', 'EDNS'].includes(err.code)) return smtpError('network', 'Could not reach the mail server. Check the host and port.');
  if (err.code === 'ETLS' || /certificate|tls|ssl/i.test(String(err.message))) return smtpError('tls', 'The secure connection to the mail server failed.');
  if (c >= 500) return smtpError('rejected', `The mail server refused the message (${c}).`);
  return smtpError('temporary', String(err.message || 'Sending failed').slice(0, 200));
}

async function transportFor(box, password) {
  const ip = await resolvePublic(box.host);
  const secure = Number(box.port) === 465;
  return nodemailer.createTransport({
    host: ip, port: Number(box.port), secure, requireTLS: !secure, auth: { user: box.username, pass: password },
    name: String(box.from_email).split('@')[1], connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    tls: { servername: net.isIP(box.host) ? undefined : box.host, minVersion: 'TLSv1.2', rejectUnauthorized: !testMode() }
  });
}

// Used when a mailbox is added or its password changes: proves we can log in before anything is saved.
export async function verifyMailbox(box) {
  try { await (await transportFor(box, box.password)).verify(); } catch (err) { throw classify(err); }
}

export function smtpProviderFor(workspace, { only = null } = {}) {
  return {
    name: 'smtp',
    async send({ to, subject, html, text, headers, replyTo }) {
      const box = only ? await claimSpecific(workspace.id, only) : await claimMailbox(workspace.id);
      if (!box) throw smtpError('capacity', 'Every mailbox has reached its daily limit, or none is switched on. It will carry on tomorrow.');
      try {
        const t = await transportFor(box, decrypt(box.password_enc));
        const info = await t.sendMail({
          from: { name: workspace.from_name || workspace.name, address: box.from_email }, to, replyTo: replyTo || undefined, subject, html, text, headers,
          messageId: `<${crypto.randomUUID()}@${String(box.from_email).split('@')[1]}>`
        });
        await recordSuccess(box.id);
        return { id: info.messageId, mailboxId: box.id };
      } catch (raw) {
        const err = classify(raw);
        err.mailboxId = box.id;
        // A refused recipient still counts as a send attempt. Anything that never got that far gives the slot back.
        if (err.kind !== 'recipient') await releaseSlot(box.id);
        if (err.kind === 'auth') await recordFailure(box.id, err.message, { disable: true }); // keep trying a wrong password and the provider locks the account
        else if (err.kind !== 'recipient') await recordFailure(box.id, err.message);
        throw err;
      }
    }
  };
}
