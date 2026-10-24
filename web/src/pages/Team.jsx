import { useEffect, useState } from 'react';
import { api, store } from '../api.js';
import { Btn, CopyBtn, useGuard } from '../ui.jsx';
import Security from './Security.jsx';
import { Deleted, ActivityLog } from './Activity.jsx';

export default function Team() {
  const guard = useGuard();
  const [members, setMembers] = useState([]);
  const [canManage, setCanManage] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [catalog, setCatalog] = useState({});
  const [edit, setEdit] = useState(null); // { user_id, role, perms:Set|null }
  const [mine, setMine] = useState([]);
  const [invite, setInvite] = useState(null);
  const [pw, setPw] = useState({ current: '', next: '', repeat: '' });

  const load = async () => { const r = await api.members(); setMembers(r.data); setCanManage(r.can_manage); };
  useEffect(() => { guard(load)(); api.permissions().then((p) => { setCatalog(p.catalog); setMine(p.mine); }).catch(() => {}); }, []);

  const add = guard(async () => {
    if (!email.trim()) throw new Error('Enter their email address');
    const res = await api.addMember(email.trim(), role);
    setEmail(''); setInvite(res.invited ? res : null);
    await load();
    return res.invited ? (res.emailed ? 'Invite emailed' : 'Person added. Copy their invite link below') : res.message;
  });

  const remove = (m) => guard(async () => {
    if (!window.confirm(`Remove ${m.email} from this workspace?`)) return;
    await api.removeMember(m.user_id);
    await load();
    return 'Person removed';
  });

  const changePassword = guard(async () => {
    if (pw.next.length < 8) throw new Error('The new password needs at least 8 characters');
    if (pw.next !== pw.repeat) throw new Error('The new passwords do not match');
    const res = await api.changePassword({ current: pw.current, next: pw.next });
    store.token = res.token; // stay signed in here, every other device is signed out
    setPw({ current: '', next: '', repeat: '' });
    return 'Password changed. Other devices were signed out';
  });

  return (
    <>
      <h1>Team</h1>
      <p className="muted" style={{ marginBottom: 20 }}>People in this workspace, and your own account.</p>

      <div className="grid cols-2">
        <div className="card">
          <h3>People</h3>
          {canManage && (
            <div className="row" style={{ margin: '12px 0 6px' }}>
              <input type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && add()} />
              <select value={role} onChange={(e) => setRole(e.target.value)} style={{ maxWidth: 130 }}>
                <option value="member">Member</option><option value="viewer">View only</option>
              </select>
              <Btn className="btn sm" busyText="Adding..." onClick={add}>Add person</Btn>
            </div>
          )}

          {invite && (
            <div className="keybox">
              <div style={{ marginBottom: 8 }}><strong>{invite.email}</strong> - {invite.emailed ? 'invite emailed. You can also share this link' : 'the email could not be sent, share this link instead'}</div>
              <div>{invite.invite_link}</div>
              <div style={{ marginTop: 10 }}><CopyBtn text={invite.invite_link} label="Copy link" /></div>
              <div className="muted" style={{ marginTop: 8 }}>The link works once and expires in 3 days.</div>
            </div>
          )}

          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="stack">
              <thead><tr><th>Person</th><th>Role</th><th></th></tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.user_id}>
                    <td data-label="Person"><strong>{m.email}</strong>{m.name && <div className="muted">{m.name}</div>}</td>
                    <td data-label="Role">
                      <span className={`pill ${m.role === 'owner' ? '' : 'gray'}`}>{m.role === 'admin' ? 'Wyntek support' : m.role === 'viewer' ? 'view only' : m.role}</span>
                      {m.permissions && <div className="muted" style={{ fontSize: 12 }}>custom permissions</div>}
                      {m.provisioned_by && <div className="muted" style={{ fontSize: 12 }}>added by {m.provisioned_by === 'scim' ? 'your IT team' : 'single sign-on'}</div>}
                    </td>
                    <td className="actions">
                      {canManage && ['member', 'viewer'].includes(m.role) && (
                        <>
                          <button className="btn ghost sm" onClick={() => setEdit(edit?.user_id === m.user_id ? null : { user_id: m.user_id, role: m.role, perms: m.permissions ? new Set(m.permissions) : null })}>Permissions</button>{' '}
                          <Btn className="btn danger sm" busyText="Removing..." onClick={remove(m)}>Remove</Btn>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {edit && (
            <div className="keybox" style={{ marginTop: 12 }}>
              <div className="between" style={{ marginBottom: 8 }}>
                <strong>What this person can do</strong>
                <select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} style={{ maxWidth: 130 }}>
                  <option value="member">Member</option><option value="viewer">View only</option>
                </select>
              </div>
              <label style={{ display: 'block', marginBottom: 8 }}>
                <input type="checkbox" checked={edit.perms === null} onChange={(e) => setEdit({ ...edit, perms: e.target.checked ? null : new Set() })} /> Use the default for their role
              </label>
              {edit.perms !== null && Object.entries(catalog).map(([k, label]) => (
                <label key={k} style={{ display: 'block', margin: '4px 0' }}>
                  <input type="checkbox" checked={edit.perms.has(k)} onChange={(e) => { const n = new Set(edit.perms); e.target.checked ? n.add(k) : n.delete(k); setEdit({ ...edit, perms: n }); }} /> {label}
                </label>
              ))}
              <div style={{ marginTop: 10 }}>
                <Btn className="btn sm" busyText="Saving..." onClick={guard(async () => {
                  await api.setPermissions(edit.user_id, { role: edit.role, permissions: edit.perms === null ? null : [...edit.perms] });
                  setEdit(null); await load(); return 'Permissions saved';
                })}>Save</Btn>{' '}
                <button className="btn ghost sm" onClick={() => setEdit(null)}>Cancel</button>
              </div>
            </div>
          )}
          {!canManage && <p className="muted" style={{ marginTop: 10 }}>Only the workspace owner can add or remove people.</p>}
        </div>

        <div className="card">
          <h3>Change password</h3>
          <p className="muted" style={{ margin: '4px 0 12px' }}>You stay signed in here. Every other device is signed out.</p>
          <div className="field"><label>Current password</label><input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
          <div className="field"><label>New password</label><input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
          <div className="field"><label>Repeat new password</label><input type="password" autoComplete="new-password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && changePassword()} /></div>
          <Btn busyText="Changing..." onClick={changePassword}>Change password</Btn>
        </div>
      </div>

      <Security />
      <Deleted canErase={canManage} />
      {canManage && <ActivityLog />}
    </>
  );
}
