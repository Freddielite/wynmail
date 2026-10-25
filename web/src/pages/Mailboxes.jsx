import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard, when } from '../ui.jsx';
import Select from '../Select.jsx';

const PRESETS = {
  zoho: { label: 'Zoho Mail', host: 'smtp.zoho.com', port: 465 },
  zoho_eu: { label: 'Zoho Mail (EU account)', host: 'smtp.zoho.eu', port: 465 },
  google: { label: 'Google Workspace', host: 'smtp.gmail.com', port: 465 },
  other: { label: 'Other mail server', host: '', port: 465 }
};
const EMPTY = { preset: 'zoho', host: 'smtp.zoho.com', port: 465, username: '', password: '', from_email: '', daily_cap: 30, label: '' };

// The normal mailboxes (Zoho Mail, Google Workspace...) this workspace sends through, each with its own daily limit.
export default function Mailboxes({ provider }) {
  const guard = useGuard();
  const [data, setData] = useState(null);
  const [denied, setDenied] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState({}); // id -> new limit being typed

  const load = async () => {
    try { setData(await api.mailboxes()); } catch (err) { if (/permission/i.test(err.message)) setDenied(true); else throw err; }
  };
  useEffect(() => { guard(load)(); }, []);
  if (denied || !data) return null;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const pick = (e) => { const p = PRESETS[e.target.value]; setForm({ ...form, preset: e.target.value, host: p.host, port: p.port }); };

  const add = guard(async () => {
    await api.addMailbox({ label: form.label, host: form.host, port: Number(form.port), username: form.username, password: form.password, from_email: form.from_email || form.username, daily_cap: Number(form.daily_cap) });
    setForm(EMPTY); setAdding(false); await load();
    return 'Mailbox connected';
  });
  const toggle = (b) => guard(async () => { await api.updateMailbox(b.id, { enabled: !b.enabled }); await load(); });
  const saveCap = (b) => guard(async () => { await api.updateMailbox(b.id, { daily_cap: Number(edit[b.id]) }); setEdit({ ...edit, [b.id]: undefined }); await load(); return 'Limit saved'; });
  const test = (b) => guard(async () => { const r = await api.testMailbox(b.id); await load(); return `Test sent to ${r.sent_to}. Check that inbox.`; });
  const remove = (b) => guard(async () => { if (!window.confirm(`Remove ${b.from_email}?`)) return; await api.deleteMailbox(b.id); await load(); return 'Removed'; });

  const cap = data.capacity;
  return (
    <div className="card" style={{ marginTop: 20 }}>
      <div className="between">
        <div>
          <h3>Sending mailboxes</h3>
          <p className="muted">Send through normal mailboxes (Zoho Mail, Google Workspace). Emails rotate between them, and each stops at its own daily limit.</p>
        </div>
        {!adding && <button className="btn sm" onClick={() => setAdding(true)}>Add a mailbox</button>}
      </div>

      {provider !== 'smtp' && <div className="keybox" style={{ margin: '12px 0' }}>This workspace still sends through <strong>{provider}</strong>. Ask Wyntek to switch it to <strong>SMTP mailboxes</strong> once your mailboxes are added.</div>}
      {data.mailboxes.length > 0 && <p style={{ margin: '12px 0' }}>Left to send today across all mailboxes: <strong>{cap.left}</strong></p>}

      {data.mailboxes.length > 0 && (
        <div className="table-wrap">
          <table className="stack">
            <thead><tr><th>Mailbox</th><th>Today</th><th>Daily limit</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {data.mailboxes.map((b) => (
                <tr key={b.id}>
                  <td data-label="Mailbox"><strong>{b.from_email}</strong><div className="muted" style={{ fontSize: 12 }}>{b.host}:{b.port}{b.label && b.label !== b.from_email ? `, ${b.label}` : ''}</div></td>
                  <td data-label="Today">{b.sent_today} sent</td>
                  <td data-label="Daily limit">
                    <div className="row" style={{ gap: 6 }}>
                      <input type="number" min="1" max={data.max_cap} style={{ width: 80 }} value={edit[b.id] ?? b.daily_cap} onChange={(e) => setEdit({ ...edit, [b.id]: e.target.value })} />
                      {edit[b.id] !== undefined && Number(edit[b.id]) !== b.daily_cap && <Btn className="btn sm" busyText="Saving..." onClick={saveCap(b)}>Save</Btn>}
                    </div>
                  </td>
                  <td data-label="Status">
                    <span className={`pill ${!b.enabled ? 'gray' : b.last_error ? 'amber' : 'green'}`}>{!b.enabled ? 'Off' : b.last_error ? 'Problem' : 'On'}</span>
                    {b.last_error && <div className="muted" style={{ fontSize: 12 }}>{b.last_error}{b.last_error_at ? ` (${when(b.last_error_at)})` : ''}</div>}
                  </td>
                  <td className="actions">
                    <Btn className="btn ghost sm" busyText="Sending..." onClick={test(b)}>Send me a test</Btn>{' '}
                    <Btn className="btn ghost sm" busyText="..." onClick={toggle(b)}>{b.enabled ? 'Switch off' : 'Switch on'}</Btn>{' '}
                    <Btn className="btn danger sm" busyText="Removing..." onClick={remove(b)}>Remove</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <div className="keybox" style={{ marginTop: 14 }}>
          <strong>Connect a mailbox</strong>
          <p className="muted" style={{ margin: '4px 0 10px' }}>Use an <strong>app password</strong>, not the mailbox's normal password. In Zoho: Account, then Security, then App Passwords. In Google: Security, then 2-Step Verification, then App passwords. The login is checked before anything is saved.</p>
          <div className="field"><label>Mail provider</label>
            <Select value={form.preset} onChange={pick}>{Object.entries(PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</Select></div>
          <div className="row">
            <div className="field" style={{ flex: 2 }}><label>Mail server</label><input value={form.host} onChange={set('host')} placeholder="smtp.example.com" /></div>
            <div className="field" style={{ flex: 1 }}><label>Port</label>
              <Select value={String(form.port)} onChange={set('port')}>{(data.ports || [465, 587]).map((p) => <option key={p} value={p}>{p}</option>)}</Select></div>
          </div>
          <div className="field"><label>Username (usually the full email address)</label><input autoComplete="off" value={form.username} onChange={set('username')} placeholder="hello@getwyntek.com" /></div>
          <div className="field"><label>App password</label><input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} /></div>
          <div className="row">
            <div className="field" style={{ flex: 2 }}><label>Send as (optional)</label><input value={form.from_email} onChange={set('from_email')} placeholder="Same as the username" /></div>
            <div className="field" style={{ flex: 1 }}><label>Daily limit</label><input type="number" min="1" max={data.max_cap} value={form.daily_cap} onChange={set('daily_cap')} /></div>
          </div>
          <p className="muted" style={{ marginBottom: 10 }}>Start at {data.default_cap} a day and raise it slowly. The sending address must be at your sending domain.</p>
          <Btn busyText="Checking login..." disabled={!form.host || !form.username || !form.password} onClick={add}>Connect and check login</Btn>{' '}
          <button className="btn ghost" onClick={() => { setAdding(false); setForm(EMPTY); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}
