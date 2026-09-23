import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Btn, useGuard } from '../ui.jsx';

const TEXT_OPS = { equals: 'is', contains: 'contains', is_empty: 'is empty', not_empty: 'is not empty' };
const FIELDS = {
  status: { label: 'Status', ops: { is: 'is', is_not: 'is not' }, value: 'status' },
  list: { label: 'List', ops: { in: 'is in', not_in: 'is not in' }, value: 'list' },
  email: { label: 'Email address', ops: { contains: 'contains', not_contains: 'does not contain', ends_with: 'ends with' }, value: 'text' },
  first_name: { label: 'First name', ops: TEXT_OPS, value: 'text' },
  last_name: { label: 'Last name', ops: TEXT_OPS, value: 'text' },
  attr: { label: 'Custom field', ops: TEXT_OPS, value: 'text', key: true },
  tag: { label: 'Tag', ops: { has: 'has', not_has: 'does not have' }, value: 'text' },
  created: { label: 'Added to Wynmail', ops: { within_days: 'in the last (days)', before_days: 'more than (days) ago' }, value: 'days' },
  opened: { label: 'Opened emails', ops: { in_last_days: 'in the last (days)', not_in_last_days: 'not in the last (days)', never: 'never' }, value: 'days' },
  clicked: { label: 'Clicked links', ops: { in_last_days: 'in the last (days)', not_in_last_days: 'not in the last (days)', never: 'never' }, value: 'days' },
  campaign: { label: 'Campaign', ops: { received: 'received', opened: 'opened', clicked: 'clicked', not_opened: 'received but did not open' }, value: 'campaign' }
};
const NO_VALUE = ['is_empty', 'not_empty', 'never'];
const STATUS = { subscribed: 'Subscribed', unsubscribed: 'Unsubscribed', bounced: 'Bounced', complained: 'Reported spam' };
const blankRule = () => ({ field: 'tag', op: 'has', value: '', key: '' });
const blank = () => ({ name: '', match: 'all', rules: [blankRule()] });

export default function Segments() {
  const guard = useGuard();
  const [items, setItems] = useState([]);
  const [lists, setLists] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [draft, setDraft] = useState(blank());
  const [editing, setEditing] = useState(null);
  const [live, setLive] = useState(null);
  const timer = useRef(null);

  const load = async () => {
    const [s, l, c] = await Promise.all([api.segments(), api.lists(), api.campaigns()]);
    setItems(s); setLists(l); setCampaigns(c.filter((x) => x.status !== 'draft'));
  };
  useEffect(() => { guard(load)(); }, []);

  const definition = () => ({ match: draft.match, rules: draft.rules.map((r) => ({ field: r.field, op: r.op, ...(FIELDS[r.field].key ? { key: r.key } : {}), ...(NO_VALUE.includes(r.op) ? {} : { value: r.value }) })) });

  // A live count that updates a moment after the last change.
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { setLive({ ...(await api.previewSegment(definition())), error: '' }); } catch (e) { setLive({ error: e.message }); }
    }, 450);
    return () => clearTimeout(timer.current);
  }, [JSON.stringify(draft.rules), draft.match]);

  const setRule = (i, patch) => setDraft({ ...draft, rules: draft.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const changeField = (i, field) => setRule(i, { field, op: Object.keys(FIELDS[field].ops)[0], value: '', key: '' });

  const save = guard(async () => {
    if (!draft.name.trim()) throw new Error('Give the segment a name');
    const body = { name: draft.name, definition: definition() };
    if (editing) await api.updateSegment(editing, body); else await api.createSegment(body);
    const msg = editing ? 'Segment saved' : 'Segment saved. Choose it when you send a campaign';
    setDraft(blank()); setEditing(null);
    await load();
    return msg;
  });

  const edit = (s) => {
    setEditing(s.id);
    setDraft({ name: s.name, match: s.definition.match, rules: s.definition.rules.map((r) => ({ key: '', value: '', ...r })) });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const remove = (s) => guard(async () => {
    if (!window.confirm(`Delete "${s.name}"? Campaigns that use it will need a new audience.`)) return;
    await api.deleteSegment(s.id);
    if (editing === s.id) { setEditing(null); setDraft(blank()); }
    await load();
    return 'Segment deleted';
  });

  const valueInput = (r, i) => {
    const spec = FIELDS[r.field];
    if (NO_VALUE.includes(r.op)) return <span className="muted">no value needed</span>;
    if (spec.value === 'status') return <select value={r.value} onChange={(e) => setRule(i, { value: e.target.value })}><option value="">Choose</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>;
    if (spec.value === 'list') return <select value={r.value} onChange={(e) => setRule(i, { value: e.target.value })}><option value="">Choose a list</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>;
    if (spec.value === 'campaign') return <select value={r.value} onChange={(e) => setRule(i, { value: e.target.value })}><option value="">Choose a campaign</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>;
    if (spec.value === 'days') return <input type="number" min="1" placeholder="days" value={r.value} onChange={(e) => setRule(i, { value: e.target.value })} />;
    return <input placeholder="value" value={r.value} onChange={(e) => setRule(i, { value: e.target.value })} />;
  };

  return (
    <>
      <h1>Segments</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Saved groups of contacts that update themselves. Use them to send to the right people, for example everyone who never opened your last email.</p>

      <div className="grid cols-2">
        <div className="card">
          <h3>{editing ? 'Edit segment' : 'New segment'}</h3>
          <div className="field" style={{ marginTop: 12 }}><label>Name</label><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Engaged in the last 30 days" /></div>
          <div className="row" style={{ marginBottom: 10 }}>
            <span>People who match</span>
            <select value={draft.match} onChange={(e) => setDraft({ ...draft, match: e.target.value })} style={{ width: 'auto' }}><option value="all">all</option><option value="any">any</option></select>
            <span>of these rules</span>
          </div>

          {draft.rules.map((r, i) => (
            <div className="rulebox" key={i}>
              <select value={r.field} onChange={(e) => changeField(i, e.target.value)}>{Object.entries(FIELDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
              {FIELDS[r.field].key && <input placeholder="field name, e.g. company" value={r.key} onChange={(e) => setRule(i, { key: e.target.value })} />}
              <select value={r.op} onChange={(e) => setRule(i, { op: e.target.value })}>{Object.entries(FIELDS[r.field].ops).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              {valueInput(r, i)}
              {draft.rules.length > 1 && <button type="button" className="btn danger sm" onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}>Remove</button>}
            </div>
          ))}
          {draft.rules.length < 10 && <button type="button" className="btn ghost sm" onClick={() => setDraft({ ...draft, rules: [...draft.rules, blankRule()] })}>Add a rule</button>}

          <div className="formitem" style={{ marginTop: 14 }}>
            {live?.error ? <span style={{ color: '#b91c1c' }}>{live.error}</span>
              : live ? <><strong>{live.total} {live.total === 1 ? 'person matches' : 'people match'}</strong><span className="muted">, {live.subscribed} can be emailed</span>
                {live.sample?.length > 0 && <div className="muted" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>{live.sample.map((p) => p.email).join(', ')}{live.total > live.sample.length ? ' ...' : ''}</div>}</>
              : <span className="muted">Counting...</span>}
          </div>

          <div className="row" style={{ marginTop: 14 }}>
            <Btn busyText="Saving..." onClick={save}>{editing ? 'Save changes' : 'Save segment'}</Btn>
            {(editing || draft.name) && <button className="btn ghost" onClick={() => { setEditing(null); setDraft(blank()); }}>{editing ? 'Cancel' : 'Clear'}</button>}
          </div>
        </div>

        <div className="card">
          <h3>Your segments</h3>
          {!items.length && <p className="muted" style={{ marginTop: 8 }}>None yet. Build your first one on the left.</p>}
          <div style={{ marginTop: 12 }}>
            {items.map((s) => (
              <div className="formitem" key={s.id}>
                <strong>{s.name}</strong>
                <div className="muted">{s.total} {s.total === 1 ? 'person' : 'people'}, {s.subscribed} can be emailed. {s.definition.rules.length} {s.definition.rules.length === 1 ? 'rule' : 'rules'}, matching {s.definition.match}.</div>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <Link className="btn ghost sm" to={`/contacts?segment=${s.id}`} style={{ textDecoration: 'none' }}>View people</Link>
                  <button className="btn ghost sm" onClick={() => edit(s)}>Edit</button>
                  <Btn className="btn danger sm" busyText="Deleting..." onClick={remove(s)}>Delete</Btn>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
