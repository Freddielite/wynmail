import { one } from './db.js';

// A segment is a saved set of rules that is worked out fresh every time it is used.
// Rules are checked against a fixed list of fields and operators, and every value is passed to
// the database as a parameter, so a segment can never inject SQL.
export const STATUSES = ['subscribed', 'unsubscribed', 'bounced', 'complained'];
const TEXT_OPS = ['equals', 'contains', 'is_empty', 'not_empty'];
const FIELDS = {
  status: { ops: ['is', 'is_not'] },
  list: { ops: ['in', 'not_in'], kind: 'id' },
  email: { ops: ['contains', 'not_contains', 'ends_with'], kind: 'text' },
  first_name: { ops: TEXT_OPS, kind: 'text' },
  last_name: { ops: TEXT_OPS, kind: 'text' },
  attr: { ops: TEXT_OPS, kind: 'text' },
  tag: { ops: ['has', 'not_has'], kind: 'tag' },
  created: { ops: ['within_days', 'before_days'], kind: 'days' },
  opened: { ops: ['in_last_days', 'not_in_last_days', 'never'], kind: 'days' },
  clicked: { ops: ['in_last_days', 'not_in_last_days', 'never'], kind: 'days' },
  campaign: { ops: ['received', 'opened', 'clicked', 'not_opened'], kind: 'id' }
};
export const MAX_RULES = 10;
const NO_VALUE = ['is_empty', 'not_empty', 'never'];

const like = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
const tagOf = (s) => String(s ?? '').trim().toLowerCase().slice(0, 30);

// Checks a definition from the outside world and returns a clean copy, or { error }.
export async function readSegment(def, workspaceId) {
  if (!def || typeof def !== 'object') return { error: 'The segment rules are missing' };
  const match = def.match === 'any' ? 'any' : 'all';
  const raw = Array.isArray(def.rules) ? def.rules : [];
  if (!raw.length) return { error: 'Add at least one rule' };
  if (raw.length > MAX_RULES) return { error: `A segment can have at most ${MAX_RULES} rules` };
  const rules = [];
  for (const [i, r] of raw.entries()) {
    const n = i + 1;
    const spec = FIELDS[r?.field];
    if (!spec) return { error: `Rule ${n}: unknown field` };
    if (!spec.ops.includes(r.op)) return { error: `Rule ${n}: that condition does not fit this field` };
    const rule = { field: r.field, op: r.op };
    if (r.field === 'attr') {
      const key = String(r.key ?? '').trim().toLowerCase();
      if (!/^[a-z0-9_]{1,40}$/.test(key)) return { error: `Rule ${n}: the custom field name can only use letters, numbers and underscores` };
      rule.key = key;
    }
    if (!NO_VALUE.includes(r.op)) {
      if (r.field === 'status') {
        if (!STATUSES.includes(r.value)) return { error: `Rule ${n}: choose a status` };
        rule.value = r.value;
      } else if (spec.kind === 'id' || (spec.kind === 'days' && r.op !== 'never')) {
        const v = Number(r.value);
        if (!Number.isInteger(v) || v < 1 || (spec.kind === 'days' && v > 3650)) return { error: `Rule ${n}: enter a whole number${spec.kind === 'days' ? ' of days' : ''}` };
        rule.value = v;
      } else if (spec.kind === 'tag') {
        rule.value = tagOf(r.value);
        if (!rule.value) return { error: `Rule ${n}: enter a tag` };
      } else {
        rule.value = String(r.value ?? '').trim().slice(0, 100);
        if (!rule.value) return { error: `Rule ${n}: enter a value` };
      }
    }
    if (r.field === 'list') {
      if (!(await one(`SELECT 1 FROM lists WHERE id = $1 AND workspace_id = $2`, [rule.value, workspaceId]))) return { error: `Rule ${n}: that list does not exist` };
    }
    if (r.field === 'campaign') {
      if (!(await one(`SELECT 1 FROM campaigns WHERE id = $1 AND workspace_id = $2`, [rule.value, workspaceId]))) return { error: `Rule ${n}: that campaign does not exist` };
    }
    rules.push(rule);
  }
  return { value: { match, rules } };
}

// Turns a clean definition into one SQL condition on the contacts table (alias c).
// Values are pushed onto `params`, and the returned text refers to them by position.
export function compileSegment(def, params) {
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const days = (v) => `now() - (${add(v)}::int * interval '1 day')`;
  const sent = (extra = '') => `EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.status = 'sent'${extra})`;
  const seen = (col, extra = '') => `EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.${col} IS NOT NULL${extra})`;

  const one = (r) => {
    const textCol = { first_name: 'c.first_name', last_name: 'c.last_name', email: 'c.email' }[r.field]
      || (r.field === 'attr' ? `(c.attributes ->> ${add(r.key)})` : null);
    switch (r.field) {
      case 'status': return r.op === 'is' ? `c.status = ${add(r.value)}` : `c.status <> ${add(r.value)}`;
      case 'list': {
        const q = `EXISTS (SELECT 1 FROM list_contacts lc JOIN lists l ON l.id = lc.list_id WHERE lc.contact_id = c.id AND l.id = ${add(r.value)} AND l.workspace_id = c.workspace_id)`;
        return r.op === 'in' ? q : `NOT ${q}`;
      }
      case 'tag': return r.op === 'has' ? `${add(r.value)} = ANY(c.tags)` : `NOT (${add(r.value)} = ANY(c.tags))`;
      case 'created': return r.op === 'within_days' ? `c.created_at >= ${days(r.value)}` : `c.created_at < ${days(r.value)}`;
      case 'opened': case 'clicked': {
        const col = r.field === 'opened' ? 'opened_at' : 'clicked_at';
        if (r.op === 'never') return `(${sent()} AND NOT ${seen(col)})`;
        if (r.op === 'in_last_days') return seen(col, ` AND m.${col} >= ${days(r.value)}`);
        const n = add(r.value);
        return `(${sent(` AND m.sent_at >= now() - (${n}::int * interval '1 day')`)} AND NOT ${seen(col, ` AND m.${col} >= now() - (${n}::int * interval '1 day')`)})`;
      }
      case 'campaign': {
        const id = add(r.value);
        const base = `m.contact_id = c.id AND m.campaign_id = ${id} AND m.workspace_id = c.workspace_id`;
        if (r.op === 'received') return `EXISTS (SELECT 1 FROM messages m WHERE ${base} AND m.status = 'sent')`;
        if (r.op === 'opened') return `EXISTS (SELECT 1 FROM messages m WHERE ${base} AND m.opened_at IS NOT NULL)`;
        if (r.op === 'clicked') return `EXISTS (SELECT 1 FROM messages m WHERE ${base} AND m.clicked_at IS NOT NULL)`;
        return `EXISTS (SELECT 1 FROM messages m WHERE ${base} AND m.status = 'sent' AND m.opened_at IS NULL)`;
      }
      default: // text fields
        switch (r.op) {
          case 'equals': return `lower(COALESCE(${textCol}, '')) = lower(${add(r.value)})`;
          case 'contains': return `COALESCE(${textCol}, '') ILIKE ${add(`%${like(r.value)}%`)}`;
          case 'not_contains': return `COALESCE(${textCol}, '') NOT ILIKE ${add(`%${like(r.value)}%`)}`;
          case 'ends_with': return `COALESCE(${textCol}, '') ILIKE ${add(`%${like(r.value)}`)}`;
          case 'is_empty': return `COALESCE(${textCol}, '') = ''`;
          default: return `COALESCE(${textCol}, '') <> ''`;
        }
    }
  };
  const parts = def.rules.map(one);
  return `(${parts.join(def.match === 'any' ? ' OR ' : ' AND ')})`;
}
