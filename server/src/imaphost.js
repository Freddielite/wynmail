// The incoming (IMAP) server that goes with an outgoing (SMTP) one: smtp.zoho.com -> imap.zoho.com, smtp.gmail.com -> imap.gmail.com.
export function imapHostFor(smtpHost) {
  const h = String(smtpHost || '').toLowerCase();
  return /^smtp(-\w+)?\./.test(h) ? h.replace(/^smtp(-\w+)?\./, 'imap.') : null;
}

