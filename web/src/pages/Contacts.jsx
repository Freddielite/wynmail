import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Contacts() {
  const [lists, setLists] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [listId, setListId] = useState('');
  const [search, setSearch] = useState('');
  const [newList, setNewList] = useState('');
  const [csv, setCsv] = useState('');
  const [single, setSingle] = useState({ email: '', first_name: '', last_name: '' });
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setLists(await api.lists());
      const q = [listId && `listId=${listId}`, search && `q=${encodeURIComponent(search)}`].filter(Boolean).join('&');
      setContacts(await api.contacts(q ? `?${q}` : ''));
    } catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, [listId]);

  const guard = (fn) => async () => {
    setError(''); setNote('');
    try { await fn(); await load(); } catch (e) { setError(e.message); }
  };

  const addList = guard(async () => {
    if (!newList.trim()) return;
    await api.createList({ name: newList.trim() });
    setNewList('');
  });

  const addContact = guard(async () => {
    if (!single.email) return;
    await api.createContact({ ...single, list_id: listId || null });
    setSingle({ email: '', first_name: '', last_name: '' });
    setNote('Contact saved.');
  });

  const importCsv = guard(async () => {
    if (!csv.trim()) return;
    const res = await api.importContacts({ csv, list_id: listId || null });
    setCsv('');
    setNote(`Imported ${res.imported}, skipped ${res.skipped}.`);
  });

  const readFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result));
    reader.readAsText(file);
  };

  return (
    <>
      <h1>Contacts</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Lists, imports and consent status.</p>
      {error && <div className="error">{error}</div>}
      {note && <div className="ok">{note}</div>}

      <div className="grid cols-side">
        <div className="grid">
          <div className="card">
            <h3>Lists</h3>
            <div className="field" style={{ marginTop: 10 }}>
              <select value={listId} onChange={(e) => setListId(e.target.value)}>
                <option value="">All contacts</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.contact_count})</option>)}
              </select>
            </div>
            <div className="row">
              <input placeholder="New list name" value={newList} onChange={(e) => setNewList(e.target.value)} />
              <button className="btn sm" onClick={addList}>Add</button>
            </div>
          </div>

          <div className="card">
            <h3>Add one contact</h3>
            <div className="field" style={{ marginTop: 10 }}>
              <input placeholder="email" value={single.email} onChange={(e) => setSingle({ ...single, email: e.target.value })} />
            </div>
            <div className="row" style={{ marginBottom: 12 }}>
              <input placeholder="first name" value={single.first_name} onChange={(e) => setSingle({ ...single, first_name: e.target.value })} />
              <input placeholder="last name" value={single.last_name} onChange={(e) => setSingle({ ...single, last_name: e.target.value })} />
            </div>
            <button className="btn sm" onClick={addContact}>Save contact</button>
          </div>

          <div className="card">
            <h3>Import CSV</h3>
            <p className="muted" style={{ marginBottom: 10 }}>Header row required, with an email column. Extra columns become merge fields.</p>
            <input type="file" accept=".csv,text/csv" onChange={readFile} style={{ marginBottom: 10 }} />
            <textarea rows="5" placeholder="email,first_name,company" value={csv} onChange={(e) => setCsv(e.target.value)} />
            <button className="btn sm" style={{ marginTop: 10 }} onClick={importCsv}>Import</button>
          </div>
        </div>

        <div className="card">
          <div className="between" style={{ marginBottom: 12 }}>
            <h3>{contacts.length} shown</h3>
            <div className="row">
              <input placeholder="Search email" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
              <button className="btn ghost sm" onClick={load}>Search</button>
            </div>
          </div>
          <div className="table-wrap">
            <table className="stack">
              <thead><tr><th>Email</th><th>Name</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id}>
                    <td data-label="Email">{c.email}</td>
                    <td data-label="Name">{[c.first_name, c.last_name].filter(Boolean).join(' ') || '-'}</td>
                    <td data-label="Status"><span className={`pill ${c.status === 'subscribed' ? 'green' : 'red'}`}>{c.status}</span></td>
                    <td className="actions">
                      <button className="btn danger sm" onClick={guard(() => api.deleteContact(c.id))}>Delete</button>
                    </td>
                  </tr>
                ))}
                {!contacts.length && <tr><td colSpan="4" className="muted">No contacts yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
