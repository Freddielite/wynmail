import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard, when } from '../ui.jsx';

const statusClass = { subscribed: 'green', unsubscribed: 'amber', bounced: 'red', complained: 'red' };

export default function Contacts() {
  const guard = useGuard();
  const [lists, setLists] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [blocked, setBlocked] = useState([]);
  const [canManage, setCanManage] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  const [listId, setListId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [target, setTarget] = useState('');
  const [search, setSearch] = useState('');
  const [newList, setNewList] = useState('');
  const [csv, setCsv] = useState('');
  const [single, setSingle] = useState({ email: '', first_name: '', last_name: '' });

  const load = async () => {
    const q = [listId && `listId=${listId}`, statusFilter && `status=${statusFilter}`, search && `q=${encodeURIComponent(search)}`].filter(Boolean).join('&');
    const [l, c, b] = await Promise.all([api.lists(), api.contacts(q ? `?${q}` : ''), api.suppressions()]);
    setLists(l); setContacts(c); setBlocked(b);
  };

  useEffect(() => { guard(load)(); setTarget(listId); }, [listId, statusFilter]);
  useEffect(() => { api.members().then((m) => setCanManage(m.can_manage)).catch(() => {}); }, []);

  const targetName = lists.find((l) => String(l.id) === String(target))?.name;

  const addList = guard(async () => {
    if (!newList.trim()) throw new Error('Type a list name first');
    const created = await api.createList({ name: newList.trim() });
    setNewList(''); setTarget(String(created.id));
    await load();
    return `List "${created.name}" created`;
  });

  const addContact = guard(async () => {
    if (!single.email.trim()) throw new Error('Enter an email address');
    await api.createContact({ ...single, list_id: target || null });
    setSingle({ email: '', first_name: '', last_name: '' });
    await load();
    return targetName ? `Added to ${targetName}` : 'Saved. Choose a list to put contacts in one';
  });

  const importCsv = guard(async () => {
    if (!csv.trim()) throw new Error('Choose a CSV file or paste rows first');
    const res = await api.importContacts({ csv, list_id: target || null });
    setCsv('');
    await load();
    const bits = [`Imported ${res.imported}${targetName ? ` into ${targetName}` : ''}`];
    if (res.duplicates) bits.push(`${res.duplicates} duplicate${res.duplicates === 1 ? '' : 's'} ignored`);
    if (res.skipped) bits.push(`${res.skipped} skipped${res.errors?.[0] ? ` (row ${res.errors[0].row}: ${res.errors[0].reason})` : ''}`);
    return bits.join(', ');
  });

  const remove = (id) => guard(async () => {
    if (!window.confirm('Delete this contact?')) return;
    await api.deleteContact(id);
    await load();
    return 'Contact deleted';
  });

  // Unblocking changes your sender reputation, so it always asks first.
  const askUnblock = (email, reason) => {
    const text = reason === 'complained'
      ? `${email} reported one of your emails as spam. Emailing them again can hurt your sender reputation. Unblock anyway?`
      : `${email} bounced, which usually means the address does not work. Only unblock it if you know it is valid now. Unblock?`;
    return window.confirm(text);
  };
  const unblockContact = (c) => guard(async () => {
    if (!askUnblock(c.email, c.status)) return;
    await api.unblockContact(c.id, true);
    await load();
    return `${c.email} can receive emails again`;
  });
  const unblockAddress = (b) => guard(async () => {
    if (!askUnblock(b.email, b.reason)) return;
    await api.unblockAddress(b.id, true);
    await load();
    return `${b.email} can receive emails again`;
  });

  const readFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result));
    reader.readAsText(file);
  };

  const listPicker = (
    <div className="field">
      <label>Add to list</label>
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">No list yet</option>
        {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </div>
  );

  return (
    <>
      <h1>Contacts</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Lists, imports and consent status.</p>

      <div className="grid cols-side">
        <div className="grid">
          <div className="card">
            <h3>Lists</h3>
            <div className="field" style={{ marginTop: 10 }}>
              <label>Show</label>
              <select value={listId} onChange={(e) => setListId(e.target.value)}>
                <option value="">All contacts</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.contact_count})</option>)}
              </select>
            </div>
            <div className="row">
              <input placeholder="New list name" value={newList} onChange={(e) => setNewList(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addList()} />
              <Btn className="btn sm" busyText="Adding..." onClick={addList}>Add</Btn>
            </div>
          </div>

          <div className="card">
            <h3>Add one contact</h3>
            <div style={{ marginTop: 10 }}>{listPicker}</div>
            <div className="field">
              <input placeholder="email" value={single.email} onChange={(e) => setSingle({ ...single, email: e.target.value })} />
            </div>
            <div className="row" style={{ marginBottom: 12 }}>
              <input placeholder="first name" value={single.first_name} onChange={(e) => setSingle({ ...single, first_name: e.target.value })} />
              <input placeholder="last name" value={single.last_name} onChange={(e) => setSingle({ ...single, last_name: e.target.value })} />
            </div>
            <Btn className="btn sm" busyText="Saving..." onClick={addContact}>Save contact</Btn>
          </div>

          <div className="card">
            <h3>Import CSV</h3>
            <p className="muted" style={{ margin: '4px 0 10px' }}>Header row required, with an email column. Extra columns become merge fields. Quoted commas, semicolons and tabs are fine. Goes into the list chosen above.</p>
            <input type="file" accept=".csv,text/csv" onChange={readFile} style={{ marginBottom: 10 }} />
            <textarea rows="5" placeholder="email,first_name,company" value={csv} onChange={(e) => setCsv(e.target.value)} />
            <Btn className="btn sm" style={{ marginTop: 10 }} busyText="Importing..." onClick={importCsv}>Import</Btn>
          </div>
        </div>

        <div className="grid">
          <div className="card">
            <div className="between" style={{ marginBottom: 12 }}>
              <h3>{contacts.length} shown</h3>
              <div className="row">
                <input placeholder="Search email" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && guard(load)()} />
                <Btn className="btn ghost sm" busyText="Searching..." onClick={guard(load)}>Search</Btn>
              </div>
            </div>
            <div className="row" style={{ marginBottom: 12 }}>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ maxWidth: 220 }}>
                <option value="">Any status</option>
                <option value="subscribed">Subscribed</option>
                <option value="unsubscribed">Unsubscribed</option>
                <option value="bounced">Bounced</option>
                <option value="complained">Reported spam</option>
              </select>
              <Btn className="btn ghost sm" busyText="Preparing..." onClick={guard(async () => { await api.exportContacts(); return 'Contacts exported'; })}>Export CSV</Btn>
            </div>
            <div className="table-wrap">
              <table className="stack">
                <thead><tr><th>Email</th><th>Name</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr key={c.id}>
                      <td data-label="Email">{c.email}</td>
                      <td data-label="Name">{[c.first_name, c.last_name].filter(Boolean).join(' ') || '-'}</td>
                      <td data-label="Status"><span className={`pill ${statusClass[c.status] || 'gray'}`}>{c.status}</span></td>
                      <td className="actions">
                        {canManage && ['bounced', 'complained'].includes(c.status) && (
                          <Btn className="btn ghost sm" busyText="Unblocking..." onClick={unblockContact(c)}>Unblock</Btn>
                        )}{' '}
                        <Btn className="btn danger sm" busyText="Deleting..." onClick={remove(c.id)}>Delete</Btn>
                      </td>
                    </tr>
                  ))}
                  {!contacts.length && <tr><td colSpan="4" className="muted">No contacts match.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="between">
              <div><h3>Blocked addresses ({blocked.length})</h3><p className="muted" style={{ marginTop: 2 }}>Bounced or reported spam. Wynmail never emails these.</p></div>
              <button className="btn ghost sm" onClick={() => setShowBlocked(!showBlocked)}>{showBlocked ? 'Hide' : 'Show'}</button>
            </div>
            {showBlocked && (
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table className="stack">
                  <thead><tr><th>Address</th><th>Reason</th><th>Since</th><th></th></tr></thead>
                  <tbody>
                    {blocked.map((b) => (
                      <tr key={b.id}>
                        <td data-label="Address">{b.email}</td>
                        <td data-label="Reason"><span className="pill red">{b.reason === 'complained' ? 'reported spam' : 'bounced'}</span></td>
                        <td data-label="Since">{when(b.created_at)}</td>
                        <td className="actions">{canManage && <Btn className="btn ghost sm" busyText="Unblocking..." onClick={unblockAddress(b)}>Unblock</Btn>}</td>
                      </tr>
                    ))}
                    {!blocked.length && <tr><td colSpan="4" className="muted">Nothing is blocked.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
