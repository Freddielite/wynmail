import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard } from '../ui.jsx';

const blank = { name: '', owner_email: '', password: '', sending_domain: '' };

export default function Clients() {
  const guard = useGuard();
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(blank);
  const [edit, setEdit] = useState(null);

  const load = async () => setRows(await api.adminWorkspaces());
  useEffect(() => { guard(load)(); }, []);

  const create = guard(async () => {
    await api.adminCreateWorkspace(form);
    setForm(blank);
    await load();
    return 'Client workspace created. Refresh to see it in the workspace switcher';
  });

  const saveEdit = guard(async () => {
    await api.adminUpdateWorkspace(edit.id, {
      sending_domain: edit.sending_domain || '', daily_limit: Number(edit.daily_limit), rate_per_minute: Number(edit.rate_per_minute)
    });
    setEdit(null);
    await load();
    return 'Client updated';
  });

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setE = (k) => (e) => setEdit({ ...edit, [k]: e.target.value });

  return (
    <>
      <h1>Clients</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Create client workspaces, approve sending domains and set limits.</p>

      <div className="grid cols-side">
        <div className="card">
          <h3>New client</h3>
          <div className="field" style={{ marginTop: 12 }}><label>Client name</label><input value={form.name} onChange={set('name')} /></div>
          <div className="field"><label>Owner email</label><input type="email" value={form.owner_email} onChange={set('owner_email')} /></div>
          <div className="field"><label>Owner password (new accounts only)</label><input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} /></div>
          <div className="field"><label>Approved sending domain</label><input placeholder="clientdomain.com" value={form.sending_domain} onChange={set('sending_domain')} /></div>
          <Btn busyText="Creating..." onClick={create}>Create workspace</Btn>
        </div>

        <div className="card">
          <h3>{rows.length} {rows.length === 1 ? 'workspace' : 'workspaces'}</h3>
          <div className="table-wrap">
            <table className="stack">
              <thead><tr><th>Workspace</th><th>Domain</th><th>Today</th><th>Limits</th><th>Members</th><th></th></tr></thead>
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
                      <Btn className="btn sm" busyText="Saving..." onClick={saveEdit}>Save</Btn>{' '}
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
