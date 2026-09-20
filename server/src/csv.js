// Small RFC 4180 style parser: quoted fields, commas and newlines inside quotes, doubled quotes,
// CRLF, a leading BOM, and comma, semicolon or tab separated files.
export function parseCsv(input) {
  const text = String(input).replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const delimiter = best[1] > 0 ? best[0] : ',';

  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  const endRow = () => {
    row.push(cur);
    cur = '';
    if (row.some((c) => c.trim() !== '')) rows.push(row.map((c) => c.trim()));
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"' && cur.trim() === '') {
      quoted = true;
      cur = '';
    } else if (ch === delimiter) {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
    } else cur += ch;
  }
  endRow();
  return rows;
}

const ALIASES = {
  email: ['email', 'e-mail', 'email address', 'emailaddress', 'e_mail'],
  first_name: ['first_name', 'firstname', 'first name', 'first', 'given name', 'given_name'],
  last_name: ['last_name', 'lastname', 'last name', 'last', 'surname', 'family name', 'family_name']
};

// Turns parsed rows into contact objects plus a list of problems, without touching the database.
export function readContacts(rows, { maxRows = 5000, isEmail, normEmail } = {}) {
  if (rows.length < 2) return { error: 'The file needs a header row and at least one contact.' };
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const find = (names) => header.findIndex((h) => names.includes(h));
  const iEmail = find(ALIASES.email);
  if (iEmail < 0) return { error: 'The header row needs an "email" column.' };
  const iFirst = find(ALIASES.first_name);
  const iLast = find(ALIASES.last_name);
  const body = rows.slice(1);
  if (body.length > maxRows) return { error: `Import at most ${maxRows} rows at a time.` };

  const contacts = [];
  const errors = [];
  const seen = new Set();
  let duplicates = 0;
  let skipped = 0;
  body.forEach((cells, n) => {
    const email = normEmail(cells[iEmail]);
    if (!isEmail(email)) {
      skipped += 1;
      if (errors.length < 5) errors.push({ row: n + 2, reason: email ? `"${email.slice(0, 40)}" is not a valid email` : 'the email is empty' });
      return;
    }
    if (seen.has(email)) { duplicates += 1; return; }
    seen.add(email);
    const attributes = {};
    header.forEach((h, j) => {
      if (j === iEmail || j === iFirst || j === iLast || !cells[j]) return;
      const key = h.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      if (key) attributes[key] = cells[j];
    });
    contacts.push({ email, first_name: cells[iFirst] || '', last_name: cells[iLast] || '', attributes });
  });
  return { contacts, skipped, duplicates, errors };
}
