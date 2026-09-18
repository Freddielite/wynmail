import { useEffect, useState } from 'react';
import { api } from '../api.js';

const blank = { name: '', subject: '', html: '', list_id: '', scheduled_at: '', template_id: '' };
const statusPill = { draft: 'gray', scheduled: 'amber', sending: 'pill', sent: 'green' };

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [lists, setLists] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [draft, setDraft] = useState(blank);
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState('');
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = async () => {
    try {
      const [c, l, t] = await Promise.all([api.campaigns(), api.lists(), api.templates()]);
      setCampaigns(c); setLists(l); setTemplates(t);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value });

  const useTemplate = (e) => {
    const t = templates.find((x) => String(x.id) === e.target.value);
    setDraft({ ...draft, template_id: e.target.value, subject: t?.subject || draft.subject, html: t?.html || draft.html });
  };

  const save = async () => {
    setError(''); setNote('');
    try {
      const body = {
        name: draft.name || draft.subject,
        subject: draft.subject,
        html: draft.html,
        list_id: Number(draft.list_id),
        scheduled_at: draft.scheduled_at ? new Date(draft.scheduled_at).toISOString() : null
      };
      if (editing) await api.updateCampaign(editing, body);
      else setEditing((await api.createCampaign(body)).id);
      setNote(draft.scheduled_at ? 'Campaign scheduled.' : 'Campaign saved as draft.');
      load();
    } catch (e) { setError(e.message); }
  };

  const send = async (id) => {
    setError(''); setNote('');
    try {
      const res = await api.sendCampaign(id);
      setNote(`${res.queued} emails queued.`);
      load();
    } catch (e) { setError(e.message); }
  };

  const showPreview = async (id) => {
    try { setPreview((await api.campaignPreview(id)).html); } catch (e) { setError(e.message); }
  };

  const openDetail = async (c) => {
    setDetail({ campaign: c, messages: await api.campaignMessages(c.id) });
  };

  const editCampaign = (c) => {
    setEditing(c.id);
    setDraft({ name: c.name, subject: c.subject, html: c.html, list_id: c.list_id || '', scheduled_at: '', template_id: '' });
    setPreview(c.html);
  };

  return (
    <>
      <h1>Campaigns</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Build, schedule and track sends.</p>
      {error && <div className="error">{error}</div>}
      {note && <div className="ok">{note}</div>}

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
        <div className="card">
          <h3>{editing ? `Editing campaign #${editing}` : 'New campaign'}</h3>
          <div className="field" style={{ marginTop: 12 }}><label>Name</label><input value={draft.name} onChange={set('name')} /></div>
          <div className="field"><label>Subject</label><input placeholder="Hello {{first_name}}" value={draft.subject} onChange={set('subject')} /></div>
          <div className="row" style={{ marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <label>List</label>
              <select value={draft.list_id} onChange={set('list_id')}>
                <option value="">Choose a list</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.contact_count})</option>)}
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
          <div className="field"><label>Schedule (leave blank to send manually)</label>
            <input type="datetime-local" value={draft.scheduled_at} onChange={set('scheduled_at')} />
          </div>
          <div className="field"><label>HTML</label>
            <textarea rows="12" value={draft.html} onChange={set('html')} />
          </div>
          <div className="row">
            <button className="btn" onClick={save}>{editing ? 'Save changes' : 'Create campaign'}</button>
            <button className="btn ghost" onClick={() => setPreview(draft.html)}>Preview HTML</button>
            {editing && <button className="btn ghost" onClick={() => { setEditing(null); setDraft(blank); }}>New</button>}
          </div>
        </div>

        <div className="grid">
          <div className="card">
            <h3>Preview</h3>
            <iframe sandbox="" referrerPolicy="no-referrer" className="preview" title="campaign-preview" srcDoc={preview || draft.html} />
            <p className="muted" style={{ marginTop: 8 }}>Rendered preview includes merge fields, tracked links and the unsubscribe footer.</p>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h3>All campaigns</h3>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>Name</th><th>List</th><th>Status</th><th>Sent</th><th>Opens</th><th>Clicks</th><th></th></tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong><div className="muted">{c.subject}</div></td>
                  <td>{c.list_name || '-'}</td>
                  <td><span className={`pill ${statusPill[c.status] || 'gray'}`}>{c.status}</span></td>
                  <td>{c.sent}/{c.total}</td>
                  <td>{c.opened}</td>
                  <td>{c.clicked}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn ghost sm" onClick={() => showPreview(c.id)}>Preview</button>{' '}
                    <button className="btn ghost sm" onClick={() => openDetail(c)}>Report</button>{' '}
                    {['draft', 'scheduled'].includes(c.status) && (
                      <>
                        <button className="btn ghost sm" onClick={() => editCampaign(c)}>Edit</button>{' '}
                        <button className="btn sm" onClick={() => send(c.id)}>Send now</button>
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
            <h3>Report: {detail.campaign.name}</h3>
            <button className="btn ghost sm" onClick={() => setDetail(null)}>Close</button>
          </div>
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table>
              <thead><tr><th>Recipient</th><th>Status</th><th>Opens</th><th>Clicks</th><th>Error</th></tr></thead>
              <tbody>
                {detail.messages.map((m) => (
                  <tr key={m.id}>
                    <td>{m.email}</td>
                    <td><span className={`pill ${m.status === 'sent' ? 'green' : m.status === 'failed' ? 'red' : 'gray'}`}>{m.status}</span></td>
                    <td>{m.open_count}</td>
                    <td>{m.click_count}</td>
                    <td className="muted">{m.error || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
