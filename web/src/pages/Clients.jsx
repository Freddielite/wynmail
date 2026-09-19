import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Clients() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ name: '', owner_email: '', password: '', sending_domain: '' });
  const [edit, setEdit] = useState(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const load = () => api.adminWorkspaces().then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const guard = (fn, msg) => async () => {
    setError(''); setNote('');
    try { await fn(); setNote(msg); await load(); } catch (e) { setError(e.message); }
  };

  const create = guard(async () => {
    await api.adminCreateWorkspace(form);
    setForm({ name: '', owner_email: '', password: '', sending_domain: '' });
  }, 'Client workspace created. Use the workspace switcher in the sidebar after a refresh.');

  const saveEdit = guard(async () => {
    await api.adminUpdateWorkspace(edit.id, {
      sending_domain: edit.sending_domain || '', daily_limit: Number(edit.daily_limit), rate_per_minute: Number(edit.rate_per_minute)
    });
    setEdit(null);
  }, 'Client updated.');

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setE = (k) => (e) => setEdit({ ...edit, [k]: e.target.value });

  return (
    <>
      <h1>Clients</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Create client workspaces, approve sending domains and set limits.</p>
      {error && <div className="error">{error}</div>}
      {note && <div className="ok">{note}</div>}

      <div className="grid cols-side">
        <div className="card">
          <h3>New client</h3>
          <div className="field" style={{ marginTop: 12 }}><label>Client name</label><input value={form.name} onChange={set('name')} /></div>
          <div className="field"><label>Owner email</label><input type="email" value={form.owner_email} onChange={set('owner_email')} /></div>
          <div className="field"><label>Owner password (new accounts only)</label><input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} /></div>
          <div className="field"><label>Approved sending domain</label><input placeholder="clientdomain.com" value={form.sending_domain} onChange={set('sending_domain')} /></div>
          <button className="btn" onClick={create}>Create workspace</button>
        </div>

        <div className="card">
          <h3>{rows.length} workspaces</h3>
          <div className="table-wrap">
            <table className="stack">
              <thead><tr><th>Workspace</th><th>Domain</th><th>Today</th><th>Limit</th><th>Members</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (edit?.id === r.id ? (
                  <tr key={r.id}>
                    <td className="title"><strong>{r.name}</strong></td>
                    <td data-label="Domain"><input value={edit.sending_domain || ''} onChange={setE('sending_domain')} /></td>
                    <td data-label="Today">{r.sent_today}</td>
                    <td data-label="Limits" style={{ minWidth: 150 }}>
                      <input type="number" title="Daily limit" value={edit.daily_limit} onChange={setE('daily_limit')} style={{ marginBottom: 6 }} />
                      <input type="number" title="Per minute" value={edit.rate_per_minute} onChange={setE('rate_per_minute')} />
                    </td>
                    <td data-label="Members" className="muted">{r.members}</td>
                    <td className="actions">
                      <button className="btn sm" onClick={saveEdit}>Save</button>{' '}
                      <button className="btn ghost sm" onClick={() => setEdit(null)}>Cancel</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={r.id}>
                    <td className="title"><strong>{r.name}</strong><div className="muted">{r.contacts} contacts</div></td>
                    <td data-label="Domain">{r.sending_domain ? r.sending_domain : <span className="pill amber">not approved</span>}</td>
                    <td data-label="Today">{r.sent_today}</td>
                    <td data-label="Limits">{r.daily_limit}/day, {r.rate_per_minute}/min</td>
                    <td data-label="Members" className="muted">{r.members}</td>
                    <td className="actions"><button className="btn ghost sm" onClick={() => setEdit({ ...r })}>Edit</button></td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
