import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard } from '../ui.jsx';

const STARTER = `<h1 style="color:#0b2a5b">Hello {{first_name}},</h1>
<p>Write your message here.</p>
<p><a href="https://wyntek.ng" style="background:#1d4ed8;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;display:inline-block">Read more</a></p>`;
const blank = { name: '', subject: '', html: STARTER };

export default function Templates() {
  const guard = useGuard();
  const [templates, setTemplates] = useState([]);
  const [draft, setDraft] = useState(blank);
  const [editing, setEditing] = useState(null);

  const load = async () => setTemplates(await api.templates());
  useEffect(() => { guard(load)(); }, []);

  const save = guard(async () => {
    if (editing) await api.updateTemplate(editing, draft);
    else await api.createTemplate(draft);
    const msg = editing ? 'Template updated' : 'Template created';
    setEditing(null); setDraft(blank);
    await load();
    return msg;
  });

  const remove = (id) => guard(async () => {
    if (!window.confirm('Delete this template?')) return;
    await api.deleteTemplate(id);
    await load();
    return 'Template deleted';
  });

  const edit = (t) => { setEditing(t.id); setDraft({ name: t.name, subject: t.subject, html: t.html }); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  return (
    <>
      <h1>Templates</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Reusable HTML with merge fields like {'{{first_name}}'}.</p>

      <div className="grid cols-2">
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
            <Btn busyText="Saving..." onClick={save}>{editing ? 'Save changes' : 'Create template'}</Btn>
            {editing && <button className="btn ghost" onClick={() => { setEditing(null); setDraft(blank); }}>Cancel</button>}
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
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn ghost sm" onClick={() => edit(t)}>Edit</button>{' '}
                      <Btn className="btn danger sm" busyText="Deleting..." onClick={remove(t.id)}>Delete</Btn>
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
