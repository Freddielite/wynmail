import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, CodeBlock, CopyBtn, useGuard, when } from '../ui.jsx';

const DEFAULT = {
  name: '', list_id: '', title: 'Subscribe to our newsletter', description: '', button_label: 'Subscribe', ask_names: true,
  consent_text: 'I agree to receive emails and understand I can unsubscribe at any time.', double_optin: true,
  success_message: 'Thanks! Check your inbox to confirm your subscription.', redirect_url: '',
  confirm_subject: 'Confirm your subscription', confirm_body: 'Please confirm your email address to finish subscribing.', active: true
};

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function snippets(f) {
  const origin = new URL(f.url).origin;
  const iframe = `<iframe id="wynmail-form" src="${f.url}?embed=1" title="${escHtml(f.title)}" style="border:0;width:100%;height:420px"></iframe>
<script>
window.addEventListener('message', function (e) {
  if (e.origin !== '${origin}') return;
  var d = e.data || {}, f = document.getElementById('wynmail-form');
  if (d.type === 'wynmail-height') f.style.height = d.height + 'px';
  if (d.type === 'wynmail-redirect' && /^https?:/.test(d.url)) location.href = d.url;
});
</script>`;
  const html = `<form action="${origin}/f/${f.slug}/subscribe" method="post">
  ${f.ask_names ? '<input type="text" name="first_name" placeholder="First name">\n  <input type="text" name="last_name" placeholder="Last name">\n  ' : ''}<input type="email" name="email" placeholder="Your email" required>
  <label><input type="checkbox" name="consent" value="on" required> ${escHtml(f.consent_text)}</label>
  <div style="position:absolute;left:-9999px" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
  <button type="submit">${escHtml(f.button_label)}</button>
</form>`;
  return { iframe, html };
}

const statusPill = { confirmed: 'green', pending: 'amber', expired: 'gray' };

export default function Forms() {
  const guard = useGuard();
  const [forms, setForms] = useState([]);
  const [lists, setLists] = useState([]);
  const [ws, setWs] = useState(null);
  const [draft, setDraft] = useState(DEFAULT);
  const [editing, setEditing] = useState(null);
  const [panel, setPanel] = useState(null);
  const [signups, setSignups] = useState([]);
  const [version, setVersion] = useState(0);

  const load = async () => {
    const [f, l, w] = await Promise.all([api.forms(), api.lists(), api.workspace()]);
    setForms(f); setLists(l); setWs(w);
  };
  useEffect(() => { guard(load)(); }, []);

  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const reset = () => { setEditing(null); setDraft(DEFAULT); };

  const save = guard(async () => {
    if (!draft.name.trim()) throw new Error('Give the form a name');
    if (!draft.list_id) throw new Error('Choose the list this form adds people to');
    const body = { ...draft, list_id: Number(draft.list_id) };
    if (editing) await api.updateForm(editing, body); else await api.createForm(body);
    const msg = editing ? 'Form updated' : 'Form created. Copy its link or embed code below';
    reset(); setVersion((v) => v + 1);
    await load();
    return msg;
  });

  const edit = (f) => {
    setEditing(f.id);
    setDraft({ name: f.name, list_id: f.list_id || '', title: f.title, description: f.description, button_label: f.button_label, ask_names: f.ask_names,
      consent_text: f.consent_text, double_optin: f.double_optin, success_message: f.success_message, redirect_url: f.redirect_url,
      confirm_subject: f.confirm_subject, confirm_body: f.confirm_body, active: f.active });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const remove = (f) => guard(async () => {
    if (!window.confirm(`Delete "${f.name}"? The link and embed code stop working. People already subscribed stay on your list.`)) return;
    await api.deleteForm(f.id);
    if (editing === f.id) reset();
    await load();
    return 'Form deleted';
  });

  const toggle = (f, kind) => guard(async () => {
    if (panel?.id === f.id && panel.kind === kind) { setPanel(null); return; }
    setPanel({ id: f.id, kind });
    if (kind === 'signups') setSignups(await api.formSignups(f.id));
  });

  const editingForm = forms.find((f) => f.id === editing);
  const senderReady = ws && ws.sending_domain && ws.from_email;

  return (
    <>
      <h1>Forms</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Signup forms that grow your lists. People confirm by email before they join.</p>

      {ws && !senderReady && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Confirmation emails need a sender</h3>
          <p className="muted">Have Wyntek approve your sending domain, then set your from email in Settings. Until then people can sign up but will not receive their confirmation email.</p>
        </div>
      )}

      <div className="grid cols-2">
        <div className="grid">
          <div className="card">
            <h3>{editing ? `Edit "${editingForm?.name || 'form'}"` : 'New form'}</h3>
            <div className="field" style={{ marginTop: 12 }}><label>Name (only you see this)</label><input value={draft.name} onChange={set('name')} placeholder="Website newsletter" /></div>
            <div className="field"><label>Add people to this list</label>
              <select value={draft.list_id} onChange={set('list_id')}>
                <option value="">Choose a list</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="field"><label>Heading</label><input value={draft.title} onChange={set('title')} /></div>
            <div className="field"><label>Short description (optional)</label><input value={draft.description} onChange={set('description')} placeholder="One email a month. No spam." /></div>
            <div className="field"><label>Button text</label><input value={draft.button_label} onChange={set('button_label')} /></div>
            <label className="check"><input type="checkbox" checked={draft.ask_names} onChange={set('ask_names')} /> Ask for first and last name</label>
            <div className="field"><label>What people agree to (shown next to the tick box)</label><textarea rows="2" value={draft.consent_text} onChange={set('consent_text')} /></div>
            <label className="check"><input type="checkbox" checked={draft.double_optin} onChange={set('double_optin')} /> Ask people to confirm by email first (recommended)</label>
            {draft.double_optin && (
              <>
                <div className="field"><label>Confirmation email subject</label><input value={draft.confirm_subject} onChange={set('confirm_subject')} /></div>
                <div className="field"><label>Confirmation email message</label><textarea rows="2" value={draft.confirm_body} onChange={set('confirm_body')} /></div>
              </>
            )}
            <div className="field"><label>Message after signing up</label><input value={draft.success_message} onChange={set('success_message')} /></div>
            <div className="field"><label>Send them to this page afterwards (optional)</label><input value={draft.redirect_url} onChange={set('redirect_url')} placeholder="https://yoursite.com/thanks" /></div>
            <label className="check"><input type="checkbox" checked={draft.active} onChange={set('active')} /> Form is live</label>
            <div className="row">
              <Btn busyText="Saving..." onClick={save}>{editing ? 'Save changes' : 'Create form'}</Btn>
              {(editing || draft.name) && <button className="btn ghost" onClick={reset}>{editing ? 'Cancel' : 'Clear'}</button>}
            </div>
          </div>

          {editingForm && (
            <div className="card">
              <h3>Live preview</h3>
              <p className="muted" style={{ margin: '4px 0 10px' }}>Shows the saved version. Saving refreshes it.</p>
              <iframe key={`${editingForm.id}-${version}`} className="formpreview" title="Form preview" src={`${editingForm.url}?embed=1`} />
            </div>
          )}
        </div>

        <div className="card">
          <h3>Your forms</h3>
          {!forms.length && <p className="muted" style={{ marginTop: 8 }}>No forms yet. Create your first one on the left.</p>}
          <div style={{ marginTop: 12 }}>
            {forms.map((f) => {
              const code = panel?.id === f.id && panel.kind === 'embed' ? snippets(f) : null;
              return (
                <div className="formitem" key={f.id}>
                  <div className="between">
                    <div>
                      <strong>{f.name}</strong> <span className={`pill ${f.active ? 'green' : 'gray'}`}>{f.active ? 'live' : 'off'}</span>
                      <div className="muted">{f.list_name || 'No list'}: {f.confirmed} subscribed, {f.pending} waiting to confirm</div>
                    </div>
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <a className="btn ghost sm" href={f.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>Open</a>
                    <CopyBtn text={f.url} label="Copy link" />
                    <Btn className="btn ghost sm" onClick={toggle(f, 'embed')}>Embed</Btn>
                    <Btn className="btn ghost sm" onClick={toggle(f, 'signups')}>Signups</Btn>
                    <button className="btn ghost sm" onClick={() => edit(f)}>Edit</button>
                    <Btn className="btn danger sm" busyText="Deleting..." onClick={remove(f)}>Delete</Btn>
                  </div>

                  {code && (
                    <div style={{ marginTop: 14 }}>
                      <CodeBlock title="Link to share" text={f.url} />
                      <CodeBlock title="Embed on a website" text={code.iframe} />
                      <CodeBlock title="Your own design (plain HTML form)" text={code.html} />
                    </div>
                  )}

                  {panel?.id === f.id && panel.kind === 'signups' && (
                    <div className="table-wrap" style={{ marginTop: 12 }}>
                      <table className="stack">
                        <thead><tr><th>Email</th><th>Status</th><th>When</th></tr></thead>
                        <tbody>
                          {signups.map((s) => (
                            <tr key={s.id}>
                              <td data-label="Email">{s.email}</td>
                              <td data-label="Status">
                                <span className={`pill ${statusPill[s.status] || 'gray'}`}>{s.status}</span>
                                {s.email_status === 'failed' && <div style={{ color: '#b91c1c', fontSize: 12 }}>Email failed: {s.email_error}</div>}
                              </td>
                              <td data-label="When">{when(s.created_at)}</td>
                            </tr>
                          ))}
                          {!signups.length && <tr><td colSpan="3" className="muted">No signups yet.</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
