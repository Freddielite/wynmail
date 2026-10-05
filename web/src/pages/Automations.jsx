import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard, usePolling, when } from '../ui.jsx';
import EditorField from '../builder/EditorField.jsx';
import { PRESETS } from '../builder/presets.js';
import { renderDesign } from '../builder/render.js';

const UNITS = { minutes: 1, hours: 60, days: 1440 };
const newStep = (over = {}) => ({ kind: 'email', id: null, value: 0, unit: 'minutes', subject: '', preview_text: '', html: '', design: null, kv: 0, stats: null,
  then_to: '', ctype: 'opened', cvalue: '', ckey: '', yes_to: '', no_to: '', tag_action: 'add', tag_value: '', ...over });
// A ready-made welcome email built with the visual builder, so a new automation only needs a list.
const welcomeStep = () => { const design = PRESETS.find((p) => p.key === 'welcome').make(); return newStep({ subject: 'Welcome, {{first_name|friend}}!', html: renderDesign(design), design }); };
const DEFAULT = () => ({ name: 'Welcome email', trigger_type: 'list_join', trigger_value: '', list_id: '', offset_days: 0, yearly: false, include_imports: false,
  goal_type: '', goal_value: '', active: true, steps: [welcomeStep()] });

const TRIGGERS = {
  list_join: 'Someone joins a list',
  tag_added: 'Someone gets a tag',
  link_click: 'Someone clicks a link in one of your emails',
  date_field: 'A date on their contact record arrives'
};
const CONDS = {
  opened: 'Opened an email', clicked: 'Clicked a link in an email', clicked_link: 'Clicked a link containing',
  has_tag: 'Has the tag', on_list: 'Is on the list', attr_equals: 'Has a field equal to'
};
const GOALS = { '': 'Nobody, send the whole sequence', tag: 'Someone gets a tag', list: 'Someone joins a list', link: 'Someone clicks a link' };

const toTarget = (t) => (t === '' || t === null || t === undefined ? null : Number(t));
const fromTarget = (t) => (t === null || t === undefined ? '' : String(t));

// When a step is removed, every jump that pointed at it or past it has to move with the steps.
const shiftTarget = (t, removed) => {
  if (t === '' || t === '-1') return t;
  const n = Number(t);
  if (n === removed) return '';
  return n > removed ? String(n - 1) : t;
};
const stepLabel = (s, i) => `Step ${i + 1}: ${s.kind === 'email' ? (s.subject || 'Email') : s.kind === 'tag' ? `${s.tag_action === 'remove' ? 'Remove' : 'Add'} tag ${s.tag_value || ''}` : 'Check'}`.slice(0, 60);

// Show a stored delay in the friendliest unit.
function splitDelay(minutes) {
  if (minutes > 0 && minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes > 0 && minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}

const runPill = { active: 'amber', completed: 'green', cancelled: 'gray' };
const runLabel = { active: 'in progress', completed: 'finished', cancelled: 'stopped' };
const endLabel = { goal: 'reached the goal', condition: 'stopped by a check', left: 'left the list', finished: 'finished' };

const triggerText = (a, listName) => {
  switch (a.trigger_type) {
    case 'tag_added': return `When someone gets the tag "${a.trigger_value}"`;
    case 'link_click': return `When someone clicks a link containing "${a.trigger_value}"`;
    case 'date_field': {
      const n = a.trigger_offset_days;
      const when = n === 0 ? 'on' : n < 0 ? `${-n} day${n === -1 ? '' : 's'} before` : `${n} day${n === 1 ? '' : 's'} after`;
      return `${when} their "${a.trigger_value}" date${a.trigger_yearly ? ', every year' : ''}`;
    }
    default: return `When someone joins ${a.list_name || listName(a.list_id) || 'a deleted list'}`;
  }
};

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
  const addStep = (kind = 'email') => setDraft({ ...draft, steps: [...draft.steps, newStep({ kind, value: kind === 'tag' ? 0 : 1, unit: 'days' })] });
  const removeStep = (i) => setDraft({
    ...draft,
    steps: draft.steps.filter((_, j) => j !== i).map((s) => ({
      ...s, then_to: shiftTarget(s.then_to, i), yes_to: shiftTarget(s.yes_to, i), no_to: shiftTarget(s.no_to, i),
      cvalue: s.kind === 'condition' && ['opened', 'clicked'].includes(s.ctype) && s.cvalue !== '' ? (Number(s.cvalue) === i ? '' : Number(s.cvalue) > i ? String(Number(s.cvalue) - 1) : s.cvalue) : s.cvalue
    }))
  });
  const reset = () => { setEditing(null); setDraft(DEFAULT()); };

  const save = guard(async () => {
    if (!draft.name.trim()) throw new Error('Give the automation a name');
    if (draft.trigger_type === 'list_join' && !draft.list_id) throw new Error('Choose the list that starts it');
    if (draft.trigger_type !== 'list_join' && !String(draft.trigger_value).trim()) throw new Error('Fill in what starts the automation');
    const body = {
      name: draft.name, trigger_type: draft.trigger_type, trigger_value: draft.trigger_value, list_id: draft.list_id ? Number(draft.list_id) : null,
      trigger_offset_days: Number(draft.offset_days || 0), trigger_yearly: draft.yearly, include_imports: draft.include_imports, active: draft.active,
      goal_type: draft.goal_type || null, goal_value: draft.goal_value,
      steps: draft.steps.map((s) => {
        const base = { kind: s.kind, delay_minutes: Math.round(Number(s.value || 0) * UNITS[s.unit]) };
        if (s.kind === 'email') return { ...base, subject: s.subject, preview_text: s.preview_text, html: s.html, design: s.design, then_to: toTarget(s.then_to) };
        if (s.kind === 'tag') return { ...base, tag_action: s.tag_action, tag_value: s.tag_value, then_to: toTarget(s.then_to) };
        const numeric = ['opened', 'clicked'].includes(s.ctype);
        const cond = { type: s.ctype, value: numeric ? (s.cvalue === '' ? null : Number(s.cvalue)) : s.ctype === 'on_list' ? Number(s.cvalue) : s.cvalue, ...(s.ctype === 'attr_equals' ? { key: s.ckey } : {}) };
        return { ...base, cond, yes_to: toTarget(s.yes_to), no_to: toTarget(s.no_to) };
      })
    };
    if (editing) await api.updateAutomation(editing, body); else await api.createAutomation(body);
    const msg = editing ? 'Automation saved' : draft.active ? 'Automation is on' : 'Automation saved, currently paused';
    reset();
    await load();
    return msg;
  });

  const edit = (id) => guard(async () => {
    const a = await api.automation(id);
    setEditing(a.id);
    setDraft({ name: a.name, trigger_type: a.trigger_type || 'list_join', trigger_value: a.trigger_value || '', list_id: a.list_id || '',
      offset_days: a.trigger_offset_days || 0, yearly: !!a.trigger_yearly, include_imports: a.include_imports, goal_type: a.goal_type || '', goal_value: a.goal_value || '',
      active: a.status === 'active',
      steps: a.steps.map((s) => {
        const base = { kind: s.kind || 'email', id: s.id, ...splitDelay(s.delay_minutes) };
        if (base.kind === 'condition') return newStep({ ...base, ctype: s.cond?.type || 'opened', cvalue: s.cond?.value === null || s.cond?.value === undefined ? '' : String(s.cond.value), ckey: s.cond?.key || '', yes_to: fromTarget(s.yes_to), no_to: fromTarget(s.no_to) });
        if (base.kind === 'tag') return newStep({ ...base, tag_action: s.tag_action || 'add', tag_value: s.tag_value || '', then_to: fromTarget(s.yes_to) });
        return newStep({ ...base, subject: s.subject, preview_text: s.preview_text || '', html: s.html, design: s.design || null, then_to: fromTarget(s.yes_to), stats: { sent: s.sent, opened: s.opened, clicked: s.clicked } });
      }) });
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

  const applyTemplate = (i, id) => {
    const t = templates.find((x) => String(x.id) === id);
    if (t) setStep(i, { subject: draft.steps[i].subject.trim() ? draft.steps[i].subject : (t.subject || ''), html: t.html || draft.steps[i].html, design: t.design || null, kv: draft.steps[i].kv + 1 });
  };

  const listName = (id) => lists.find((l) => String(l.id) === String(id))?.name;
  const senderReady = ws && ws.sending_domain && ws.from_email && ws.footer_address;

  return (
    <>
      <h1>Automations</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Emails that send by themselves: a welcome series, a follow-up after a click, a birthday message, or a renewal reminder. Add checks to send people down different paths, and a goal to stop emailing people who already did what you wanted.</p>

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

          <div className="stepbox">
            <strong>Start</strong>
            <div className="field" style={{ marginTop: 10 }}><label>Start when</label>
              <select value={draft.trigger_type} onChange={(e) => setDraft({ ...draft, trigger_type: e.target.value, trigger_value: '' })}>
                {Object.entries(TRIGGERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            {draft.trigger_type === 'list_join' && (
              <div className="field"><label>List</label>
                <select value={draft.list_id} onChange={(e) => setDraft({ ...draft, list_id: e.target.value })}>
                  <option value="">Choose a list</option>
                  {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            )}
            {draft.trigger_type === 'tag_added' && <div className="field"><label>Tag</label><input value={draft.trigger_value} onChange={(e) => setDraft({ ...draft, trigger_value: e.target.value })} placeholder="vip" /></div>}
            {draft.trigger_type === 'link_click' && (
              <div className="field"><label>Link contains</label><input value={draft.trigger_value} onChange={(e) => setDraft({ ...draft, trigger_value: e.target.value })} placeholder="pricing" />
                <div className="muted" style={{ marginTop: 4 }}>Part of the address is enough. Clicks by security scanners do not count.</div></div>
            )}
            {draft.trigger_type === 'date_field' && (<>
              <div className="field"><label>Contact field that holds the date</label><input value={draft.trigger_value} onChange={(e) => setDraft({ ...draft, trigger_value: e.target.value })} placeholder="birthday" />
                <div className="muted" style={{ marginTop: 4 }}>Dates must be written like 2026-12-31. Anything else is ignored. Add the field in a CSV column or on a contact.</div></div>
              <div className="delayrow">
                <input type="number" value={draft.offset_days} onChange={(e) => setDraft({ ...draft, offset_days: e.target.value })} />
                <span>days from the date. Use a negative number for before, like -7 for a week ahead, and 0 for the day itself.</span>
              </div>
              <label className="check"><input type="checkbox" checked={draft.yearly} onChange={(e) => setDraft({ ...draft, yearly: e.target.checked })} /> Repeat every year (birthdays, anniversaries)</label>
            </>)}
            {['list_join', 'tag_added'].includes(draft.trigger_type) && (<>
              <label className="check"><input type="checkbox" checked={draft.include_imports} onChange={(e) => setDraft({ ...draft, include_imports: e.target.checked })} /> Also start for people added by CSV import</label>
              <p className="muted" style={{ margin: '-4px 0 8px' }}>Off by default, so a big import cannot email everyone by surprise. Existing members are never emailed when you turn an automation on.</p>
            </>)}
            <p className="muted" style={{ margin: 0 }}>Each person goes through it once{draft.trigger_type === 'date_field' && draft.yearly ? ' a year' : ''}.</p>
          </div>

          {draft.steps.map((s, i) => {
            const later = draft.steps.map((x, j) => ({ x, j })).filter(({ j }) => j > i);
            const targets = (value, onChange, carry) => (
              <select value={value} onChange={(e) => onChange(e.target.value)}>
                <option value="">{carry}</option>
                <option value="-1">Stop here</option>
                {later.map(({ x, j }) => <option key={j} value={String(j)}>Skip to {stepLabel(x, j)}</option>)}
              </select>
            );
            const emailsBefore = draft.steps.map((x, j) => ({ x, j })).filter(({ x, j }) => j < i && x.kind === 'email');
            const label = s.kind === 'email' ? `Step ${i + 1}: Email` : s.kind === 'condition' ? `Step ${i + 1}: Check` : `Step ${i + 1}: Tag`;
            return (
            <div className="stepbox" key={i}>
              <div className="between">
                <strong>{label}</strong>
                <div className="row">
                  {s.stats && <span className="stepstats">{s.stats.sent} sent, {s.stats.opened} opened, {s.stats.clicked} clicked</span>}
                  {draft.steps.length > 1 && <button className="btn danger sm" onClick={() => removeStep(i)}>Remove</button>}
                </div>
              </div>
              <div className="delayrow" style={{ marginTop: 10 }}>
                <span>{s.kind === 'email' ? 'Send' : 'Do this'}</span>
                <input type="number" min="0" value={s.value} onChange={(e) => setStep(i, { value: e.target.value })} />
                <select value={s.unit} onChange={(e) => setStep(i, { unit: e.target.value })}>
                  <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
                </select>
                <span>{Number(s.value) === 0 ? (i === 0 ? 'straight away' : 'straight away') : (i === 0 ? 'after they start' : 'after the step before it')}</span>
              </div>

              {s.kind === 'email' && (<>
                <div className="field"><label>Subject</label><input value={s.subject} onChange={(e) => setStep(i, { subject: e.target.value })} placeholder="Welcome, {{first_name}}!" /></div>
                <div className="field"><label>Preview text (optional)</label><input value={s.preview_text} maxLength={150} onChange={(e) => setStep(i, { preview_text: e.target.value })} placeholder="The short line inboxes show after the subject" /></div>
                {templates.length > 0 && (
                  <div className="field"><label>Start from a template</label>
                    <select value="" onChange={(e) => applyTemplate(i, e.target.value)}>
                      <option value="">Choose a template to fill this email</option>
                      {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                )}
                <label>Content</label>
                <EditorField key={`${i}-${s.kv}`} value={s} onChange={(v) => setStep(i, { html: v.html, design: v.design })} templates={templates} />
                <Btn className="btn ghost sm" busyText="Sending test..." onClick={sendTest(s)}>Send test to me</Btn>
                {i < draft.steps.length - 1 && <div className="field" style={{ marginTop: 12 }}><label>Then</label>{targets(s.then_to, (v) => setStep(i, { then_to: v }), 'Carry on to the next step')}</div>}
              </>)}

              {s.kind === 'condition' && (<>
                <div className="field"><label>Check whether the person</label>
                  <select value={s.ctype} onChange={(e) => setStep(i, { ctype: e.target.value, cvalue: '', ckey: '' })}>
                    {Object.entries(CONDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                {['opened', 'clicked'].includes(s.ctype) && (
                  <div className="field"><label>Which email</label>
                    <select value={s.cvalue} onChange={(e) => setStep(i, { cvalue: e.target.value })}>
                      <option value="">The last email they got</option>
                      {emailsBefore.map(({ x, j }) => <option key={j} value={String(j)}>{stepLabel(x, j)}</option>)}
                    </select>
                  </div>
                )}
                {s.ctype === 'clicked_link' && <div className="field"><label>Link contains</label><input value={s.cvalue} onChange={(e) => setStep(i, { cvalue: e.target.value })} placeholder="pricing" /></div>}
                {s.ctype === 'has_tag' && <div className="field"><label>Tag</label><input value={s.cvalue} onChange={(e) => setStep(i, { cvalue: e.target.value })} placeholder="vip" /></div>}
                {s.ctype === 'on_list' && (
                  <div className="field"><label>List</label>
                    <select value={s.cvalue} onChange={(e) => setStep(i, { cvalue: e.target.value })}>
                      <option value="">Choose a list</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </div>
                )}
                {s.ctype === 'attr_equals' && (
                  <div className="row"><div className="field" style={{ flex: 1 }}><label>Field</label><input value={s.ckey} onChange={(e) => setStep(i, { ckey: e.target.value })} placeholder="plan" /></div>
                    <div className="field" style={{ flex: 1 }}><label>Equal to</label><input value={s.cvalue} onChange={(e) => setStep(i, { cvalue: e.target.value })} placeholder="pro" /></div></div>
                )}
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <div className="field" style={{ flex: 1 }}><label>If yes</label>{targets(s.yes_to, (v) => setStep(i, { yes_to: v }), 'Carry on to the next step')}</div>
                  <div className="field" style={{ flex: 1 }}><label>If no</label>{targets(s.no_to, (v) => setStep(i, { no_to: v }), 'Carry on to the next step')}</div>
                </div>
              </>)}

              {s.kind === 'tag' && (<>
                <div className="row">
                  <div className="field" style={{ flex: 1 }}><label>Action</label>
                    <select value={s.tag_action} onChange={(e) => setStep(i, { tag_action: e.target.value })}><option value="add">Add the tag</option><option value="remove">Remove the tag</option></select></div>
                  <div className="field" style={{ flex: 1 }}><label>Tag</label><input value={s.tag_value} onChange={(e) => setStep(i, { tag_value: e.target.value })} placeholder="engaged" /></div>
                </div>
                {i < draft.steps.length - 1 && <div className="field"><label>Then</label>{targets(s.then_to, (v) => setStep(i, { then_to: v }), 'Carry on to the next step')}</div>}
              </>)}
            </div>
            );
          })}

          <div className="row" style={{ flexWrap: 'wrap', marginBottom: 14 }}>
            {draft.steps.length < 20 && draft.steps.filter((x) => x.kind === 'email').length < 10 && <button className="btn ghost sm" onClick={() => addStep('email')}>Add an email</button>}
            {draft.steps.length < 20 && <button className="btn ghost sm" onClick={() => addStep('condition')}>Add a check</button>}
            {draft.steps.length < 20 && <button className="btn ghost sm" onClick={() => addStep('tag')}>Add a tag step</button>}
          </div>
          <p className="muted" style={{ margin: '-4px 0 14px' }}>A check sends people down different paths. Paths only go forward, so nothing can loop. A tag step adds or removes a tag, which can start another automation.</p>

          <div className="stepbox">
            <strong>Stop early</strong>
            <div className="field" style={{ marginTop: 10 }}><label>Stop the sequence when</label>
              <select value={draft.goal_type} onChange={(e) => setDraft({ ...draft, goal_type: e.target.value, goal_value: '' })}>
                {Object.entries(GOALS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            {draft.goal_type === 'tag' && <div className="field"><label>Tag</label><input value={draft.goal_value} onChange={(e) => setDraft({ ...draft, goal_value: e.target.value })} placeholder="customer" /></div>}
            {draft.goal_type === 'list' && (
              <div className="field"><label>List</label>
                <select value={draft.goal_value} onChange={(e) => setDraft({ ...draft, goal_value: e.target.value })}>
                  <option value="">Choose a list</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            )}
            {draft.goal_type === 'link' && <div className="field"><label>Link contains</label><input value={draft.goal_value} onChange={(e) => setDraft({ ...draft, goal_value: e.target.value })} placeholder="checkout" /></div>}
            <p className="muted" style={{ margin: 0 }}>{draft.goal_type ? 'Anyone who does this gets no more emails from the sequence, like a buyer who no longer needs a sales email.' : 'Leave this off to send every step to everyone.'}</p>
          </div>

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
                  <div className="muted">{triggerText(a, listName)}, {a.steps} {a.steps === 1 ? 'email' : 'emails'}{a.step_count > a.steps ? ` and ${a.step_count - a.steps} other ${a.step_count - a.steps === 1 ? 'step' : 'steps'}` : ''}</div>
                  <div className="muted">{a.in_progress} in progress, {a.completed} finished, {a.sent} {a.sent === 1 ? 'email' : 'emails'} sent, {a.opened} opened{a.goal_type ? `, ${a.goal_reached} reached the goal` : ''}</div>
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
                      <thead><tr><th>Person</th><th>Status</th><th>Progress</th><th>Next step</th></tr></thead>
                      <tbody>
                        {runs.map((r) => (
                          <tr key={r.id}>
                            <td data-label="Person">{r.email}</td>
                            <td data-label="Status"><span className={`pill ${r.ended_reason === 'goal' ? 'green' : runPill[r.status] || 'gray'}`}>{(r.status !== 'active' && endLabel[r.ended_reason]) || runLabel[r.status] || r.status}</span></td>
                            <td data-label="Progress">{r.status === 'active' ? `At step ${Math.min(r.current_step + 1, r.total_steps)} of ${r.total_steps}` : `${r.total_steps} steps`}</td>
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
