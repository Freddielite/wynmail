import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard, usePolling, when } from '../ui.jsx';
import EditorField from '../builder/EditorField.jsx';
import CampaignAnalytics from './CampaignAnalytics.jsx';
import PreCheck from './PreCheck.jsx';
import AbReport from './AbReport.jsx';

const blank = { name: '', subject: '', preview_text: '', html: '', design: null, audience: 'list', list_id: '', segment_id: '', scheduled_at: '', template_id: '',
  ab: false, subject_b: '', ab_percent: 20, ab_wait_hours: 4, ab_metric: 'opens', timing: 'now', local_at: '' };
const outcome = (m) => {
  if (m.status === 'held') return { label: 'waiting for test', cls: 'gray' };
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
  const [editorKey, setEditorKey] = useState(0);
  const [preview, setPreview] = useState('');
  const [detail, setDetail] = useState(null);
  const [messages, setMessages] = useState([]);
  const [check, setCheck] = useState(null);
  const [resend, setResend] = useState(null);

  const [segments, setSegments] = useState([]);
  const loadAll = async () => {
    const [c, l, t, sg] = await Promise.all([api.campaigns(), api.lists(), api.templates(), api.segments()]);
    setCampaigns(c); setLists(l); setTemplates(t); setSegments(sg);
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
  const skipped = draft.audience === 'list' && picked ? picked.contact_count - picked.subscribed_count : 0;
  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value });
  const reset = () => { setEditing(null); setDraft(blank); setPreview(''); setEditorKey((k) => k + 1); };

  const useTemplate = (e) => {
    const t = templates.find((x) => String(x.id) === e.target.value);
    if (!t) return setDraft({ ...draft, template_id: '' });
    if (draft.html.trim() && !window.confirm('Replace what you have written with this template?')) return;
    setDraft({ ...draft, template_id: e.target.value, subject: draft.subject.trim() ? draft.subject : (t.subject || ''), html: t.html, design: t.design || null });
    setEditorKey((k) => k + 1);
  };

  // A/B test and delivery timing, as the server wants them. A set time in each person's zone sets the schedule itself.
  const resultOptions = () => ({
    subject_b: draft.ab ? draft.subject_b : '', ab_percent: Number(draft.ab_percent), ab_wait_hours: Number(draft.ab_wait_hours), ab_metric: draft.ab_metric,
    best_time: draft.timing === 'best', local_time: draft.timing === 'local', local_at: draft.timing === 'local' ? draft.local_at : ''
  });

  const persist = async (scheduleAt, asSend = false) => {
    if (draft.ab && !draft.subject_b.trim()) throw new Error('Write subject B, or turn the test off');
    if (draft.timing === 'local' && !draft.local_at) throw new Error('Pick the date and time to send at in each person\'s own time zone');
    if (!draft.subject.trim()) throw new Error('Add a subject first');
    if (draft.audience === 'list' && !draft.list_id) throw new Error('Choose a list first');
    if (draft.audience === 'segment' && !draft.segment_id) throw new Error('Choose a segment first');
    if (asSend && !draft.html.trim()) throw new Error('Add some content first, the email is empty');
    const body = { name: draft.name || draft.subject, subject: draft.subject, html: draft.html, design: draft.design, preview_text: draft.preview_text,
      list_id: draft.audience === 'list' ? Number(draft.list_id) : null, segment_id: draft.audience === 'segment' ? Number(draft.segment_id) : null, scheduled_at: scheduleAt, ...resultOptions() };
    if (editing) { await api.updateCampaign(editing, body); return editing; }
    const created = await api.createCampaign(body);
    setEditing(created.id);
    return created.id;
  };

  const checkBody = (deep = false) => ({ subject: draft.subject, html: draft.html, preview_text: draft.preview_text,
    list_id: draft.audience === 'list' && draft.list_id ? Number(draft.list_id) : null,
    segment_id: draft.audience === 'segment' && draft.segment_id ? Number(draft.segment_id) : null, deep,
    subject_b: draft.ab ? draft.subject_b : '', ab_percent: Number(draft.ab_percent), best_time: draft.timing === 'best', local_time: draft.timing === 'local' });
  const runCheck = (deep) => guard(async () => {
    if (!draft.subject.trim() && !draft.html.trim()) throw new Error('Write the email first, then check it');
    setCheck(await api.precheck(checkBody(deep)));
    setTimeout(() => document.getElementById('precheck')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  });

  const sendTest = guard(async () => {
    if (!draft.subject.trim()) throw new Error('Add a subject first');
    if (!draft.html.trim()) throw new Error('Add some content first');
    const res = await api.testEmail({ subject: draft.subject, html: draft.html, preview_text: draft.preview_text });
    return `Test sent to ${res.to}. Check your inbox and spam`;
  });

  const saveDraft = guard(async () => { await persist(null); await loadAll(); return 'Draft saved'; });

  const launch = guard(async () => {
    // A quick check first. If it finds real problems, the person decides whether to go ahead.
    if (draft.subject.trim() && draft.html.trim()) {
      let r = null;
      try { r = await api.precheck(checkBody(false)); } catch { /* the check never blocks a send by failing */ }
      if (r && r.verdict === 'risky') {
        setCheck(r);
        const n = r.fails;
        if (!window.confirm(`The check found ${n} problem${n === 1 ? '' : 's'} that could hurt delivery. Send anyway?`)) {
          setTimeout(() => document.getElementById('precheck')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
          return;
        }
      }
    }
    if (draft.timing === 'local') {
      await persist(null, true);
      reset(); await loadAll();
      return `Scheduled. Each person gets it at ${draft.local_at.replace('T', ' ')} in their own time zone`;
    }
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
    if (draft.ab) return `Test started. The first ${res.queued} people are being split between your two subjects`;
    return `Sending to ${res.queued} ${res.queued === 1 ? 'subscriber' : 'subscribers'}`;
  });

  const sendRow = (id) => guard(async () => {
    const res = await api.sendCampaign(id);
    await loadAll();
    return `Sending to ${res.queued} ${res.queued === 1 ? 'subscriber' : 'subscribers'}`;
  });

  const showPreview = (id) => guard(async () => {
    setPreview((await api.campaignPreview(id)).html);
    setTimeout(() => document.getElementById('rendered-preview')?.scrollIntoView({ behavior: 'smooth' }), 50);
  });

  const edit = (c) => {
    setEditing(c.id);
    setDraft({ name: c.name, subject: c.subject, preview_text: c.preview_text || '', html: c.html, design: c.design || null, audience: c.segment_id ? 'segment' : 'list', list_id: c.list_id || '', segment_id: c.segment_id || '', scheduled_at: '', template_id: '',
      ab: !!c.subject_b, subject_b: c.subject_b || '', ab_percent: c.ab_percent || 20, ab_wait_hours: c.ab_wait_hours || 4, ab_metric: c.ab_metric || 'opens',
      timing: c.local_time ? 'local' : c.best_time ? 'best' : 'now', local_at: c.local_at || '' });
    setEditorKey((k) => k + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const duplicate = (c) => guard(async () => {
    const copy = await api.duplicateCampaign(c.id);
    await loadAll();
    edit(copy);
    return 'Copy created. Edit it below, then send';
  });

  const startResend = (c) => setResend({ id: c.id, name: c.name, subject: '', count: c.non_openers });
  const sendResend = guard(async () => {
    const r = await api.resendCampaign(resend.id, resend.subject);
    setResend(null); await loadAll();
    return `Resending to ${r.queued} ${r.queued === 1 ? 'person' : 'people'} who did not open it`;
  });

  const openReport = (c) => guard(async () => { setDetail(c); setMessages(await api.campaignMessages(c.id)); });

  return (
    <>
      <h1>Campaigns</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Build, schedule and track sends.</p>

      <div className="card">
        <h3>{editing ? `Editing campaign #${editing}` : 'New campaign'}</h3>
        <div className="grid cols-2" style={{ marginTop: 12 }}>
          <div>
            <div className="field"><label>Name</label><input value={draft.name} onChange={set('name')} /></div>
            <div className="field"><label>Subject</label><input placeholder="Hello {{first_name|there}}" value={draft.subject} onChange={set('subject')} />
              <div className="muted" style={{ marginTop: 4 }}>Tip: <code>{'{{first_name|there}}'}</code> uses "there" when a contact has no first name.</div>
            </div>
            <div className="field"><label>Preview text (optional)</label><input placeholder="The short line inboxes show after the subject" maxLength={150} value={draft.preview_text} onChange={set('preview_text')} /></div>

            <label className="optline"><input type="checkbox" checked={draft.ab} disabled={draft.timing !== 'now'} onChange={(e) => setDraft({ ...draft, ab: e.target.checked })} />
              <span>Test two subject lines<small>A small group gets each subject. The better one goes to everyone else.</small></span></label>
            {draft.ab && (
              <div className="card" style={{ margin: '0 0 14px', background: 'var(--soft, #f8fafc)' }}>
                <div className="field"><label>Subject B</label><input placeholder="A different way to say it" value={draft.subject_b} onChange={set('subject_b')} /></div>
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>Test group</label>
                    <select value={draft.ab_percent} onChange={set('ab_percent')}>{[10, 20, 30, 40, 50].map((n) => <option key={n} value={n}>{n}% of the audience</option>)}</select></div>
                  <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>Pick the winner by</label>
                    <select value={draft.ab_metric} onChange={set('ab_metric')}><option value="opens">Opens</option><option value="clicks">Clicks</option></select></div>
                  <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>After waiting</label>
                    <select value={draft.ab_wait_hours} onChange={set('ab_wait_hours')}>{[1, 2, 4, 8, 24, 48].map((n) => <option key={n} value={n}>{n} hour{n === 1 ? '' : 's'}</option>)}</select></div>
                </div>
                <div className="muted" style={{ marginTop: 8 }}>Needs at least 20 people. Opens are counted from privacy proxies too, so clicks are the more honest measure for a list that reads in Apple Mail.</div>
              </div>
            )}
          </div>
          <div>
            <div className="row" style={{ marginBottom: 10 }}>
              <button type="button" className={`btn sm ${draft.audience === 'list' ? '' : 'ghost'}`} onClick={() => setDraft({ ...draft, audience: 'list' })}>Send to a list</button>
              <button type="button" className={`btn sm ${draft.audience === 'segment' ? '' : 'ghost'}`} onClick={() => setDraft({ ...draft, audience: 'segment' })}>Send to a segment</button>
            </div>
            <div className="row" style={{ marginBottom: 14, alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                {draft.audience === 'list' ? (<>
                  <label>List</label>
                  <select value={draft.list_id} onChange={set('list_id')}>
                    <option value="">Choose a list</option>
                    {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.subscribed_count} can receive)</option>)}
                  </select>
                </>) : (<>
                  <label>Segment</label>
                  <select value={draft.segment_id} onChange={set('segment_id')}>
                    <option value="">Choose a segment</option>
                    {segments.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.subscribed} can receive)</option>)}
                  </select>
                  {!segments.length && <div className="muted" style={{ marginTop: 4 }}>No segments yet. Create one on the Segments page.</div>}
                </>)}
              </div>
              <div style={{ flex: 1 }}>
                <label>Start from template</label>
                <select value={draft.template_id} onChange={useTemplate}>
                  <option value="">None</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            </div>
            {skipped > 0 && <div className="muted" style={{ margin: '-6px 0 14px' }}>{skipped} of {picked.contact_count} contacts in this list will be skipped: they unsubscribed, bounced or reported spam.</div>}
            <div className="field">
              <label>When it goes out</label>
              <select value={draft.timing} onChange={(e) => setDraft({ ...draft, timing: e.target.value, ab: e.target.value === 'now' ? draft.ab : false, scheduled_at: e.target.value === 'now' ? draft.scheduled_at : '' })}>
                <option value="now">At one time for everyone</option>
                <option value="best">At each person's best time</option>
                <option value="local">At a set time in each person's own time zone</option>
              </select>
              {draft.timing === 'now' && (<>
                <input type="datetime-local" style={{ marginTop: 8 }} value={draft.scheduled_at} onChange={set('scheduled_at')} />
                <div className="muted" style={{ marginTop: 4 }}>{draft.scheduled_at ? 'The main button will schedule this campaign.' : 'Leave empty to send right away.'}</div>
              </>)}
              {draft.timing === 'best' && <div className="muted" style={{ marginTop: 6 }}>Starts right away. Each person gets it in the hour they usually open email, within the next 24 hours. People with fewer than three opens use the hour most of your list opens in.</div>}
              {draft.timing === 'local' && (<>
                <input type="datetime-local" style={{ marginTop: 8 }} value={draft.local_at} onChange={set('local_at')} />
                <div className="muted" style={{ marginTop: 4 }}>Everyone gets it at this clock time where they live. People with no time zone saved use your workspace zone. Set zones on Contacts or in a CSV column called timezone.</div>
              </>)}
              {draft.ab && draft.timing === 'now' && <div className="muted" style={{ marginTop: 6 }}>An A/B test starts right away, so it cannot be scheduled.</div>}
            </div>
          </div>
        </div>

        <label style={{ marginTop: 6 }}>Content</label>
        <EditorField key={editorKey} value={draft} onChange={(v) => setDraft((d) => ({ ...d, html: v.html, design: v.design }))} templates={templates} />

        <div className="row" style={{ flexWrap: 'wrap', marginTop: 16 }}>
          <Btn busyText={draft.scheduled_at || draft.timing === 'local' ? 'Scheduling...' : 'Sending...'} onClick={launch}>{draft.timing === 'local' || draft.scheduled_at ? 'Schedule campaign' : draft.ab ? 'Start test' : draft.timing === 'best' ? 'Send at best times' : 'Send now'}</Btn>
          <Btn className="btn ghost" busyText="Saving..." onClick={saveDraft}>Save draft</Btn>
          <Btn className="btn ghost" busyText="Checking..." onClick={runCheck(false)}>Check before sending</Btn>
          <Btn className="btn ghost" busyText="Sending test..." onClick={sendTest}>Send test to me</Btn>
          {(editing || draft.subject || draft.html) && <button className="btn ghost" onClick={reset}>Clear</button>}
        </div>
      </div>

      {check && <PreCheck result={check} onClose={() => setCheck(null)} onDeep={runCheck(true)} />}

      {preview && (
        <div className="card" id="rendered-preview" style={{ marginTop: 18 }}>
          <div className="between"><h3>Rendered preview</h3><button className="btn ghost sm" onClick={() => setPreview('')}>Close</button></div>
          <p className="muted" style={{ margin: '4px 0 10px' }}>Exactly as the first contact would receive it, with tracked links and the footer.</p>
          <iframe sandbox="" referrerPolicy="no-referrer" className="preview" title="campaign-preview" srcDoc={preview} />
        </div>
      )}

      {resend && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="between"><h3>Resend to people who did nothing</h3><button className="btn ghost sm" onClick={() => setResend(null)}>Cancel</button></div>
          <p className="muted" style={{ margin: '4px 0 10px' }}>About {resend.count} people got "{resend.name}" and did not open or click it. They get the same email again, so use a new subject. People who unsubscribed, bounced or complained are left out. You can resend once.</p>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>New subject</label><input value={resend.subject} onChange={(e) => setResend({ ...resend, subject: e.target.value })} placeholder="Did you miss this?" /></div>
            <Btn busyText="Sending..." onClick={sendResend}>Resend now</Btn>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 18 }}>
        <div className="between"><h3>All campaigns</h3>{sending && <span className="muted">Updating live</span>}</div>
        <div className="table-wrap">
          <table className="stack">
            <thead><tr><th>Name</th><th>List</th><th>Status</th><th>Sent</th><th>Opens</th><th>Clicks</th><th></th></tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td className="title"><strong>{c.name}</strong><div className="muted">{c.subject}</div></td>
                  <td data-label="List">{c.list_name || (c.segment_name ? `Segment: ${c.segment_name}` : '-')}</td>
                  <td data-label="Status">
                    <span className={`pill ${pillClass[c.status] || 'gray'}${c.status === 'sending' ? ' live' : ''}`}>{c.status}</span>
                    {c.status === 'scheduled' && <div className="muted">{c.local_time ? `${(c.local_at || '').replace('T', ' ')} local time` : when(c.scheduled_at)}</div>}
                    {c.status === 'sending' && c.held > 0 && <div className="muted">{c.held} waiting for the test result</div>}
                    {c.status === 'sending' && c.timed_waiting > 0 && <div className="muted">{c.timed_waiting} waiting for their time</div>}
                    {c.subject_b && <div className="muted">A/B test{c.ab_winner ? `: ${c.ab_winner} won` : ''}</div>}
                    {c.resend_of_name && <div className="muted">Resend of {c.resend_of_name}</div>}
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
                    {c.status === 'sent' && !c.resent && !c.resend_of_name && c.non_openers > 0 && <><button className="btn ghost sm" onClick={() => startResend(c)}>Resend to {c.non_openers} who did nothing</button>{' '}</>}
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
          {detail.subject_b && <AbReport id={detail.id} />}
          <CampaignAnalytics id={detail.id} />
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="stack">
              <thead><tr><th>Recipient</th><th>Status</th><th>Opens</th><th>Clicks</th><th>Error</th></tr></thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id}>
                    <td data-label="Recipient">{m.email}{m.ab_test && <> <span className="pill gray">test {m.variant}</span></>}{!m.ab_test && m.variant && <> <span className="pill gray">winner {m.variant}</span></>}</td>
                    <td data-label="Status"><span className={`pill ${outcome(m).cls}`} title={m.bounce_type || ''}>{outcome(m).label}</span>{m.status === 'queued' && m.send_after && new Date(m.send_after) > new Date() && <div className="muted">goes {when(m.send_after)}</div>}</td>
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
