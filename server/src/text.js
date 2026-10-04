const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '', hellip: '...', mdash: '-', ndash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ''; }
  return Object.hasOwn(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
});

// A readable plain text version of an email: links keep their address, blocks become lines.
// Inboxes score a message with no text part as less trustworthy, so every email ships with one.
export function htmlToText(html) {
  let s = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*?href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
      const label = decode(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      const url = decode(href).trim();
      if (!/^https?:\/\//i.test(url)) return label ? ` ${label} ` : ' ';
      return !label || label.replace(/\/$/, '') === url.replace(/\/$/, '') ? ` ${url} ` : ` ${label} (${url}) `;
    })
    .replace(/<img\b[^>]*?alt\s*=\s*"([^"]+)"[^>]*>/gi, ' $1 ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li|table|ul|ol|blockquote)>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');
  s = decode(s);
  return s.split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
