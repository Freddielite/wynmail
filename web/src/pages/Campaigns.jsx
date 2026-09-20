import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard, usePolling, when } from '../ui.jsx';

const blank = { name: '', subject: '', preview_text: '', html: '', list_id: '', scheduled_at: '', template_id: '' };
const outcome = (m) => {
  if (m.complained_at) return { label: 'spam complaint', cls: 'red' };
  if (m.bounced_at) return { label: m.bounce_type === 'Permanent' ? 'bounced' : 'soft bounce', cls: m.bounce_type === 'Permanent' ? 'red' : 'amber' };
  if (m.delivered_at) return { label: 'delivered', cls: 'green' };
  return { label: m.status, cls: m.status === 'sent' ? 'green' : m.status === 'failed' ? 'red' : 'gray' };
};
const pillClass = { draft: 'gray', scheduled: 'amber', sending: 'live', sent: 'green' };

export default function Campaigns() {
  const guard = useGuard();
  const [campaigns, setCampaigns] = useState([]);
  const [lists, setLists] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [draft, setDraft] = useState(blank);
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState('');
  const [detail, setDetail] = useState(null);
  const [messages, setMessages] = useState([]);

  const loadAll = async () => {
    const [c, l, t] = await Promise.all([api.campaigns(), api.lists(), api.templates()]);
    setCampaigns(c); setLists(l); setTemplates(t);
  };
  const refresh = async () => {
    try {
      setCampaigns(await api.campaigns());
      if (detail) setMessages(await api.campaignMessages(detail.id));
    } catch { /* keep the last good view */ }
  };
  useEffect(() => { guard(loadAll)(); }, []);

  // Status updates itself: fast while a campaign is sending, slower while one is scheduled.
  const sending = campaigns.some((c) => c.status === 'sending');
  const scheduled = campaigns.some((c) => c.status === 'scheduled');
  usePolling(refresh, sending, 3000);
  usePolling(refresh, scheduled && !sending, 10000);

  const picked = lists.find((l) => String(l.id) === String(draft.list_id));
  const skipped = picked ? picked.contact_count - picked.subscribed_count : 0;
  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value });
  const reset = () => { setEditing(null); setDraft(blank); setPreview(''); };

  const useTemplate = (e) => {
    const t = templates.find((x) => String(x.id) === e.target.value);
    setDraft({ ...draft, template_id: e.target.value, subject: t?.subject || draft.subject, html: t?.html || draft.html });
  };

  const persist = async (scheduleAt, asSend = false) => {
    if (!draft.subject.trim()) throw new Error('Add a subject first');
    if (!draft.list_id) throw new Error('Choose a list first');
    if (asSend && !draft.html.trim()) throw new Error('Add some content first, the email is empty');
    const body = { name: draft.name || draft.subject, subject: draft.subject, html: draft.html, preview_text: draft.preview_text,
      list_id: Number(draft.list_id), scheduled_at: scheduleAt };
    if (editing) { await api.updateCampaign(editing, body); return editing; }
    const created = await api.createCampaign(body);
    setEditing(created.id);
    return created.id;
  };

  const sendTest = guard(async () => {
    if (!draft.subject.trim()) throw new Error('Add a subject first');
    if (!draft.html.trim()) throw new Error('Add some content first');
    const res = await api.testEmail({ subject: draft.subject, html: draft.html, preview_text: draft.preview_text });
    return `Test sent to ${res.to}. Check your inbox and spam`;
  });

  const saveDraft = guard(async () => { await persist(null); await loadAll(); return 'Draft saved'; });

  const launch = guard(async () => {
    if (draft.scheduled_at) {
      const at = new Date(draft.scheduled_at);
      if (at <= new Date()) throw new Error('Pick a time in the future, or clear the schedule to send now');
      await persist(at.toISOString(), true);
      reset(); await loadAll();
      return `Scheduled for ${at.toLocaleString()}`;
    }
    const id = await persist(null, true);
    const res = await api.sendCampaign(id);
    reset(); await loadAll();
    return `Sending to ${res.queued} ${res.queued === 1 ? 'subscriber' : 'subscribers'}`;
  });

  const sendRow = (id) => guard(async () => {
    const res = await api.sendCampaign(id);
    await loadAll();
    return `Sending to ${res.queued} ${res.queued === 1 ? 'subscriber' : 'subscribers'}`;
  });

  const showPreview = (id) => guard(async () => {
    setPreview((await api.campaignPreview(id)).html);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  const duplicate = (c) => guard(async () => {
    const copy = await api.duplicateCampaign(c.id);
    await loadAll();
    edit(copy);
    return `Copy created. Edit it below, then send`;
  });

  const openReport = (c) => guard(async () => { setDetail(c); setMessages(await api.campaignMessages(c.id)); });

  const edit = (c) => {
    setEditing(c.id);
    setDraft({ name: c.name, subject: c.subject, preview_text: c.preview_text || '', html: c.html, list_id: c.list_id || '', scheduled_at: '', template_id: '' });
    setPreview(c.html);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <>
      <h1>Campaigns</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Build, schedule and track sends.</p>

      <div className="grid cols-2">
        <div className="card">
          <h3>{editing ? `Editing campaign #${editing}` : 'New campaign'}</h3>
          <div className="field" style={{ marginTop: 12 }}><label>Name</label><input value={draft.name} onChange={set('name')} /></div>
          <div className="field"><label>Subject</label><input placeholder="Hello {{first_name|there}}" value={draft.subject} onChange={set('subject')} />
            <div className="muted" style={{ marginTop: 4 }}>Tip: <code>{'{{first_name|there}}'}</code> uses "there" when a contact has no first name.</div>
          </div>
          <div className="field"><label>Preview text (optional)</label><input placeholder="The short line inboxes show after the subject" maxLength={150} value={draft.preview_text} onChange={set('preview_text')} /></div>
          <div className="row" style={{ marginBottom: 14, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <label>List</label>
              <select value={draft.list_id} onChange={set('list_id')}>
                <option value="">Choose a list</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.subscribed_count} can receive)</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label>Start from template</label>
              <select value={draft.template_id} onChange={useTemplate}>
                <option value="">None</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>
          {skipped > 0 && (
            <div className="muted" style={{ margin: '-6px 0 14px' }}>
              {skipped} of {picked.contact_count} contacts in this list will be skipped: they unsubscribed, bounced or reported spam.
            </div>
          )}
          <div className="field">
            <label>Send later (optional)</label>
            <input type="datetime-local" value={draft.scheduled_at} onChange={set('scheduled_at')} />
            <div className="muted" style={{ marginTop: 4 }}>{draft.scheduled_at ? 'The main button will schedule this campaign.' : 'Leave empty to send right away.'}</div>
          </div>
          <div className="field"><label>HTML</label>
            <textarea rows="12" value={draft.html} onChange={set('html')} />
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Btn busyText={draft.scheduled_at ? 'Scheduling...' : 'Sending...'} onClick={launch}>
              {draft.scheduled_at ? 'Schedule campaign' : 'Send now'}
            </Btn>
            <Btn className="btn ghost" busyText="Saving..." onClick={saveDraft}>Save draft</Btn>
            <Btn className="btn ghost" busyText="Sending test..." onClick={sendTest}>Send test to me</Btn>
            <button className="btn ghost" onClick={() => setPreview(draft.html)}>Preview</button>
            {(editing || draft.subject || draft.html) && <button className="btn ghost" onClick={reset}>Clear</button>}
          </div>
        </div>

        <div className="card">
          <h3>Preview</h3>
          <iframe sandbox="" referrerPolicy="no-referrer" className="preview" title="campaign-preview" srcDoc={preview || draft.html} />
          <p className="muted" style={{ marginTop: 8 }}>The editor preview shows raw merge fields. Use Preview on a saved campaign to see tracked links and the footer.</p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="between"><h3>All campaigns</h3>{sending && <span className="muted">Updating live</span>}</div>
        <div className="table-wrap">
          <table className="stack">
            <thead><tr><th>Name</th><th>List</th><th>Status</th><th>Sent</th><th>Opens</th><th>Clicks</th><th></th></tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td className="title"><strong>{c.name}</strong><div className="muted">{c.subject}</div></td>
                  <td data-label="List">{c.list_name || '-'}</td>
                  <td data-label="Status">
                    <span className={`pill ${pillClass[c.status] || 'gray'}${c.status === 'sending' ? ' live' : ''}`}>{c.status}</span>
                    {c.status === 'scheduled' && <div className="muted">{when(c.scheduled_at)}</div>}
                  </td>
                  <td data-label="Sent">
                    <div>{c.sent}/{c.total}</div>
                    {c.bounced > 0 && <div style={{ color: '#b91c1c', fontSize: 12 }}>{c.bounced} bounced</div>}
                    {c.complained > 0 && <div style={{ color: '#b91c1c', fontSize: 12 }}>{c.complained} spam complaint{c.complained === 1 ? '' : 's'}</div>}
                    {c.status === 'sending' && c.total > 0 && <div className="bar"><i style={{ width: `${Math.round((c.sent / c.total) * 100)}%` }} /></div>}
                  </td>
                  <td data-label="Opens">{c.opened}</td>
                  <td data-label="Clicks">{c.clicked}</td>
                  <td className="actions">
                    <Btn className="btn ghost sm" busyText="Loading..." onClick={showPreview(c.id)}>Preview</Btn>{' '}
                    <Btn className="btn ghost sm" busyText="Loading..." onClick={openReport(c)}>Report</Btn>{' '}
                    <Btn className="btn ghost sm" busyText="Copying..." onClick={duplicate(c)}>Duplicate</Btn>{' '}
                    {['draft', 'scheduled'].includes(c.status) && (
                      <>
                        <button className="btn ghost sm" onClick={() => edit(c)}>Edit</button>{' '}
                        <Btn className="btn sm" busyText="Sending..." onClick={sendRow(c.id)}>Send now</Btn>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!campaigns.length && <tr><td colSpan="7" className="muted">No campaigns yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="between">
            <h3>Report: {detail.name}</h3>
            <div className="row">
              <Btn className="btn ghost sm" busyText="Preparing..." onClick={guard(async () => { await api.exportCampaign(detail.id); return 'Report exported'; })}>Download CSV</Btn>
              <button className="btn ghost sm" onClick={() => setDetail(null)}>Close</button>
            </div>
          </div>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="stack">
              <thead><tr><th>Recipient</th><th>Status</th><th>Opens</th><th>Clicks</th><th>Error</th></tr></thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id}>
                    <td data-label="Recipient">{m.email}</td>
                    <td data-label="Status"><span className={`pill ${outcome(m).cls}`} title={m.bounce_type || ''}>{outcome(m).label}</span></td>
                    <td data-label="Opens">{m.open_count}</td>
                    <td data-label="Clicks">{m.click_count}</td>
                    <td data-label="Error" className="muted">{m.error || '-'}</td>
                  </tr>
                ))}
                {!messages.length && <tr><td colSpan="5" className="muted">No recipients yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
