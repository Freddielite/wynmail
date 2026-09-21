import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard, usePolling, when } from '../ui.jsx';
import EditorField from '../builder/EditorField.jsx';
import { PRESETS } from '../builder/presets.js';
import { renderDesign } from '../builder/render.js';

const UNITS = { minutes: 1, hours: 60, days: 1440 };
const newStep = (over = {}) => ({ id: null, value: 0, unit: 'minutes', subject: '', preview_text: '', html: '', design: null, kv: 0, stats: null, ...over });
// A ready-made welcome email built with the visual builder, so a new automation only needs a list.
const welcomeStep = () => { const design = PRESETS.find((p) => p.key === 'welcome').make(); return newStep({ subject: 'Welcome, {{first_name|friend}}!', html: renderDesign(design), design }); };
const DEFAULT = () => ({ name: 'Welcome email', list_id: '', include_imports: false, active: true, steps: [welcomeStep()] });

// Show a stored delay in the friendliest unit.
function splitDelay(minutes) {
  if (minutes > 0 && minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes > 0 && minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}

const runPill = { active: 'amber', completed: 'green', cancelled: 'gray' };
const runLabel = { active: 'in progress', completed: 'finished', cancelled: 'stopped' };

export default function Automations() {
  const guard = useGuard();
  const [items, setItems] = useState([]);
  const [lists, setLists] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [ws, setWs] = useState(null);
  const [draft, setDraft] = useState(DEFAULT());
  const [editing, setEditing] = useState(null);
  const [people, setPeople] = useState(null);
  const [runs, setRuns] = useState([]);

  const load = async () => {
    const [a, l, t, w] = await Promise.all([api.automations(), api.lists(), api.templates(), api.workspace()]);
    setItems(a); setLists(l); setTemplates(t); setWs(w);
  };
  useEffect(() => { guard(load)(); }, []);

  // Numbers move on their own while people are working through a sequence.
  const busy = items.some((a) => a.in_progress > 0);
  usePolling(async () => {
    try { setItems(await api.automations()); if (people) setRuns(await api.automationRuns(people)); } catch { /* keep the last view */ }
  }, busy, 5000);

  const setStep = (i, patch) => setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const addStep = () => setDraft({ ...draft, steps: [...draft.steps, newStep({ value: 1, unit: 'days' })] });
  const removeStep = (i) => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) });
  const reset = () => { setEditing(null); setDraft(DEFAULT()); };

  const save = guard(async () => {
    if (!draft.name.trim()) throw new Error('Give the automation a name');
    if (!draft.list_id) throw new Error('Choose the list that starts it');
    const body = {
      name: draft.name, list_id: Number(draft.list_id), include_imports: draft.include_imports, active: draft.active,
      steps: draft.steps.map((s) => ({ delay_minutes: Math.round(Number(s.value || 0) * UNITS[s.unit]), subject: s.subject, preview_text: s.preview_text, html: s.html, design: s.design }))
    };
    if (editing) await api.updateAutomation(editing, body); else await api.createAutomation(body);
    const msg = editing ? 'Automation saved' : draft.active ? 'Automation is on. New people on the list will get these emails' : 'Automation saved, currently paused';
    reset();
    await load();
    return msg;
  });

  const edit = (id) => guard(async () => {
    const a = await api.automation(id);
    setEditing(a.id);
    setDraft({ name: a.name, list_id: a.list_id || '', include_imports: a.include_imports, active: a.status === 'active',
      steps: a.steps.map((s) => newStep({ id: s.id, ...splitDelay(s.delay_minutes), subject: s.subject, preview_text: s.preview_text || '', html: s.html, design: s.design || null, stats: { sent: s.sent, opened: s.opened, clicked: s.clicked } })) });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  const toggle = (a) => guard(async () => {
    await api.setAutomationStatus(a.id, a.status !== 'active');
    await load();
    return a.status === 'active' ? 'Paused. Nothing more will send until you turn it on' : 'Turned on';
  });

  const remove = (a) => guard(async () => {
    if (!window.confirm(`Delete "${a.name}"? People still waiting for an email will not get it.`)) return;
    await api.deleteAutomation(a.id);
    if (editing === a.id) reset();
    if (people === a.id) setPeople(null);
    await load();
    return 'Automation deleted';
  });

  const showPeople = (a) => guard(async () => {
    if (people === a.id) { setPeople(null); return; }
    setPeople(a.id); setRuns(await api.automationRuns(a.id));
  });

  const sendTest = (s) => guard(async () => {
    if (!s.subject.trim()) throw new Error('Add a subject first');
    if (!s.html.trim()) throw new Error('Add some content first');
    const res = await api.testEmail({ subject: s.subject, html: s.html, preview_text: s.preview_text });
    return `Test sent to ${res.to}. Check your inbox and spam`;
  });

  const useTemplate = (i, id) => {
    const t = templates.find((x) => String(x.id) === id);
    if (t) setStep(i, { subject: draft.steps[i].subject.trim() ? draft.steps[i].subject : (t.subject || ''), html: t.html || draft.steps[i].html, design: t.design || null, kv: draft.steps[i].kv + 1 });
  };

  const listName = (id) => lists.find((l) => String(l.id) === String(id))?.name;
  const senderReady = ws && ws.sending_domain && ws.from_email && ws.footer_address;

  return (
    <>
      <h1>Automations</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Emails that send by themselves after someone joins a list, like a welcome message and follow-ups.</p>

      {ws && !senderReady && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Finish sender setup first</h3>
          <p className="muted">Automations can be saved now, but they can only be turned on once Wyntek has approved your sending domain and your from email and footer address are set in Settings.</p>
        </div>
      )}

      <div className="grid">
        <div className="card">
          <h3>{editing ? 'Edit automation' : 'New automation'}</h3>
          <div className="field" style={{ marginTop: 12 }}><label>Name (only you see this)</label><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
          <div className="field"><label>Start when someone joins this list</label>
            <select value={draft.list_id} onChange={(e) => setDraft({ ...draft, list_id: e.target.value })}>
              <option value="">Choose a list</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <label className="check"><input type="checkbox" checked={draft.include_imports} onChange={(e) => setDraft({ ...draft, include_imports: e.target.checked })} /> Also start for people added by CSV import</label>
          <p className="muted" style={{ margin: '-4px 0 8px' }}>Off by default, so a big import cannot email everyone already on your list by surprise. Existing members are never emailed when you turn an automation on.</p>

          {draft.steps.map((s, i) => (
            <div className="stepbox" key={i}>
              <div className="between">
                <strong>Email {i + 1}</strong>
                <div className="row">
                  {s.stats && <span className="stepstats">{s.stats.sent} sent, {s.stats.opened} opened, {s.stats.clicked} clicked</span>}
                  {draft.steps.length > 1 && <button className="btn danger sm" onClick={() => removeStep(i)}>Remove</button>}
                </div>
              </div>
              <div className="delayrow" style={{ marginTop: 10 }}>
                <span>Send</span>
                <input type="number" min="0" value={s.value} onChange={(e) => setStep(i, { value: e.target.value })} />
                <select value={s.unit} onChange={(e) => setStep(i, { unit: e.target.value })}>
                  <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
                </select>
                <span>{Number(s.value) === 0 ? (i === 0 ? 'right after they join' : 'right after the previous email') : (i === 0 ? 'after they join' : 'after the previous email')}</span>
              </div>
              <div className="field"><label>Subject</label><input value={s.subject} onChange={(e) => setStep(i, { subject: e.target.value })} placeholder="Welcome, {{first_name}}!" /></div>
              <div className="field"><label>Preview text (optional)</label><input value={s.preview_text} maxLength={150} onChange={(e) => setStep(i, { preview_text: e.target.value })} placeholder="The short line inboxes show after the subject" /></div>
              {templates.length > 0 && (
                <div className="field"><label>Start from a template</label>
                  <select value="" onChange={(e) => useTemplate(i, e.target.value)}>
                    <option value="">Choose a template to fill this email</option>
                    {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              )}
              <label>Content</label>
              <EditorField key={`${i}-${s.kv}`} value={s} onChange={(v) => setStep(i, { html: v.html, design: v.design })} templates={templates} />
              <Btn className="btn ghost sm" busyText="Sending test..." onClick={sendTest(s)}>Send test to me</Btn>
            </div>
          ))}

          {draft.steps.length < 10 && <button className="btn ghost sm" onClick={addStep} style={{ marginBottom: 14 }}>Add another email</button>}
          <label className="check"><input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> Turn on</label>
          <div className="row">
            <Btn busyText="Saving..." onClick={save}>{editing ? 'Save changes' : 'Create automation'}</Btn>
            {editing && <button className="btn ghost" onClick={reset}>Cancel</button>}
          </div>
        </div>

        <div className="card">
          <div className="between"><h3>Your automations</h3>{busy && <span className="muted">Updating live</span>}</div>
          {!items.length && <p className="muted" style={{ marginTop: 8 }}>None yet. The welcome email on the left is ready to go, just choose a list.</p>}
          <div style={{ marginTop: 12 }}>
            {items.map((a) => (
              <div className="formitem" key={a.id}>
                <div>
                  <strong>{a.name}</strong> <span className={`pill ${a.status === 'active' ? 'green' : 'gray'}`}>{a.status === 'active' ? 'on' : 'paused'}</span>
                  <div className="muted">When someone joins {a.list_name || listName(a.list_id) || 'a deleted list'}, {a.steps} {a.steps === 1 ? 'email' : 'emails'}</div>
                  <div className="muted">{a.in_progress} in progress, {a.completed} finished, {a.sent} {a.sent === 1 ? 'email' : 'emails'} sent, {a.opened} opened</div>
                </div>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <Btn className="btn ghost sm" busyText="Loading..." onClick={edit(a.id)}>Edit</Btn>
                  <Btn className="btn ghost sm" busyText="Working..." onClick={toggle(a)}>{a.status === 'active' ? 'Pause' : 'Turn on'}</Btn>
                  <Btn className="btn ghost sm" onClick={showPeople(a)}>People</Btn>
                  <Btn className="btn danger sm" busyText="Deleting..." onClick={remove(a)}>Delete</Btn>
                </div>

                {people === a.id && (
                  <div className="table-wrap" style={{ marginTop: 12 }}>
                    <table className="stack">
                      <thead><tr><th>Person</th><th>Status</th><th>Progress</th><th>Next email</th></tr></thead>
                      <tbody>
                        {runs.map((r) => (
                          <tr key={r.id}>
                            <td data-label="Person">{r.email}</td>
                            <td data-label="Status"><span className={`pill ${runPill[r.status] || 'gray'}`}>{runLabel[r.status] || r.status}</span></td>
                            <td data-label="Progress">{Math.min(r.current_step, r.total_steps)} of {r.total_steps} sent</td>
                            <td data-label="Next email">{r.status === 'active' ? when(r.next_at) : '-'}</td>
                          </tr>
                        ))}
                        {!runs.length && <tr><td colSpan="4" className="muted">Nobody has entered this automation yet.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
