import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard } from '../ui.jsx';
import EditorField from '../builder/EditorField.jsx';

const blank = { name: '', subject: '', html: '', design: null };

export default function Templates() {
  const guard = useGuard();
  const [templates, setTemplates] = useState([]);
  const [draft, setDraft] = useState(blank);
  const [editing, setEditing] = useState(null);
  const [editorKey, setEditorKey] = useState(0);

  const load = async () => setTemplates(await api.templates());
  useEffect(() => { guard(load)(); }, []);

  const reset = () => { setEditing(null); setDraft(blank); setEditorKey((k) => k + 1); };

  const save = guard(async () => {
    if (!draft.name.trim()) throw new Error('Give the template a name');
    if (!draft.html.trim()) throw new Error('Add some content first');
    const body = { name: draft.name, subject: draft.subject, html: draft.html, design: draft.design };
    if (editing) await api.updateTemplate(editing, body); else await api.createTemplate(body);
    const msg = editing ? 'Template updated' : 'Template saved. Use it from campaigns and automations';
    reset();
    await load();
    return msg;
  });

  const remove = (id) => guard(async () => {
    if (!window.confirm('Delete this template?')) return;
    await api.deleteTemplate(id);
    await load();
    return 'Template deleted';
  });

  const edit = (t) => {
    setEditing(t.id);
    setDraft({ name: t.name, subject: t.subject, html: t.html, design: t.design || null });
    setEditorKey((k) => k + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <>
      <h1>Templates</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Design emails once, reuse them everywhere. Merge fields like {'{{first_name|there}}'} work in any text.</p>

      <div className="card">
        <h3>{editing ? 'Edit template' : 'New template'}</h3>
        <div className="row" style={{ margin: '12px 0', alignItems: 'flex-start' }}>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>Name</label><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>Subject (optional)</label><input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></div>
        </div>
        <EditorField key={editorKey} value={draft} onChange={(v) => setDraft((d) => ({ ...d, html: v.html, design: v.design }))} templates={templates.filter((t) => t.id !== editing)} />
        <div className="row" style={{ marginTop: 14 }}>
          <Btn busyText="Saving..." onClick={save}>{editing ? 'Save changes' : 'Save template'}</Btn>
          {(editing || draft.name || draft.html) && <button className="btn ghost" onClick={reset}>{editing ? 'Cancel' : 'Clear'}</button>}
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h3>Saved templates</h3>
        <table style={{ marginTop: 8 }}>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td><strong>{t.name}</strong> <span className="pill gray">{t.design ? 'visual' : 'html'}</span><div className="muted">{t.subject}</div></td>
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
    </>
  );
}
