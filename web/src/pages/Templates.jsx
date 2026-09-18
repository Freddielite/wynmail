import { useEffect, useState } from 'react';
import { api } from '../api.js';

const STARTER = `<h1 style="color:#0b2a5b">Hello {{first_name}},</h1>
<p>Write your message here.</p>
<p><a href="https://wyntek.ng" style="background:#1d4ed8;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;display:inline-block">Read more</a></p>`;

export default function Templates() {
  const [templates, setTemplates] = useState([]);
  const [draft, setDraft] = useState({ name: '', subject: '', html: STARTER });
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.templates().then(setTemplates).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const save = async () => {
    setError('');
    try {
      if (editing) await api.updateTemplate(editing, draft);
      else await api.createTemplate(draft);
      setEditing(null);
      setDraft({ name: '', subject: '', html: STARTER });
      load();
    } catch (e) { setError(e.message); }
  };

  const edit = (t) => { setEditing(t.id); setDraft({ name: t.name, subject: t.subject, html: t.html }); };

  const remove = async (id) => { await api.deleteTemplate(id); load(); };

  return (
    <>
      <h1>Templates</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Reusable HTML with merge fields like {'{{first_name}}'}.</p>
      {error && <div className="error">{error}</div>}

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
        <div className="card">
          <h3>{editing ? 'Edit template' : 'New template'}</h3>
          <div className="field" style={{ marginTop: 12 }}>
            <label>Name</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="field">
            <label>Subject</label>
            <input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          </div>
          <div className="field">
            <label>HTML</label>
            <textarea rows="14" value={draft.html} onChange={(e) => setDraft({ ...draft, html: e.target.value })} />
          </div>
          <div className="row">
            <button className="btn" onClick={save}>{editing ? 'Save changes' : 'Create template'}</button>
            {editing && <button className="btn ghost" onClick={() => { setEditing(null); setDraft({ name: '', subject: '', html: STARTER }); }}>Cancel</button>}
          </div>
        </div>

        <div className="grid">
          <div className="card">
            <h3>Live preview</h3>
            <iframe sandbox="" referrerPolicy="no-referrer" className="preview" title="preview" srcDoc={draft.html} />
          </div>
          <div className="card">
            <h3>Saved</h3>
            <table>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td><strong>{t.name}</strong><div className="muted">{t.subject}</div></td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn ghost sm" onClick={() => edit(t)}>Edit</button>{' '}
                      <button className="btn danger sm" onClick={() => remove(t.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
                {!templates.length && <tr><td className="muted">No templates yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
