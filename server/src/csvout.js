// Spreadsheet-safe CSV. Cells that start with = + - @ are prefixed with an apostrophe so Excel
// and Sheets never run them as formulas.
export const csvCell = (v) => {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvLine = (cells) => cells.map(csvCell).join(',');
