import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Btn, useGuard, usePolling, when } from '../ui.jsx';

const LABEL = {
  saved: ['Saved', 'green'], duplicate: ['Already a contact', 'gray'], suppressed: ['Do not email', 'red'], free_email: ['Personal inbox', 'gray'],
  eu: ['EU, skipped', 'gray'], invalid: ['Bad address', 'amber']
};
const SITE = { pending: 'Waiting', done: 'Done', failed: 'Could not read', blocked: 'Not allowed', skipped: 'Stopped' };

// Paste company websites, Wynmail reads what each one prints publicly, checks the addresses and saves the good new ones to Prospects.
export default function Prospector() {
  const guard = useGuard();
  const [info, setInfo] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [open, setOpen] = useState(null); // job detail
  const [text, setText] = useState('');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [rejected, setRejected] = useState([]);
  const [show, setShow] = useState('all');
  const [denied, setDenied] = useState(false);

  const load = async () => {
    try {
      const [i, j] = await Promise.all([api.prospectorInfo(), api.prospectorJobs()]);
      setInfo(i); setJobs(j);
      const target = open?.job.id ?? j[0]?.id;
      if (target) setOpen(await api.prospectorJob(target));
    } catch (err) { if (/permission/i.test(err.message)) setDenied(true); else throw err; }
  };
  useEffect(() => { guard(load)(); }, []);
  const running = open?.job && ['queued', 'running'].includes(open.job.status);
  usePolling(() => guard(load)(), running, 3000);

  const readFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { setCsv(String(reader.result || '')); setFileName(f.name); };
    reader.readAsText(f);
  };

  const start = guard(async () => {
    const r = await api.prospectorStart({ text, csv });
    setRejected(r.rejected || []); setText(''); setCsv(''); setFileName('');
    setOpen(await api.prospectorJob(r.job.id)); setJobs(await api.prospectorJobs());
    return `Searching ${r.job.total_sites} websites`;
  });
  const stop = guard(async () => { await api.prospectorCancel(open.job.id); await load(); return 'Stopped'; });
  const pick = guard(async (id) => { setOpen(await api.prospectorJob(id)); });
  const remove = (row) => guard(async () => {
    if (!window.confirm(`Remove ${row.email}? You can restore them for 30 days from Team > Recently deleted.`)) return;
    await api.deleteContact(row.contact_id); await load(); return 'Removed';
  });

  if (denied) return <div className="card"><h2>Prospector</h2><p className="muted">You do not have permission to use the Prospector. Ask the workspace owner.</p></div>;

  const rows = (open?.results || []).filter((r) => show === 'all' || (show === 'saved' ? r.status === 'saved' : r.status !== 'saved'));
  const counts = (open?.results || []).reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  const pct = open?.job?.total_sites ? Math.round((open.job.done_sites / open.job.total_sites) * 100) : 0;

  return (
    <>
      <div className="between" style={{ marginBottom: 6 }}>
        <div><h1>Prospector</h1><p className="muted">Find business emails printed on company websites.</p></div>
        {info?.prospects_list_id && <Link className="btn ghost sm" to="/contacts">Open Prospects</Link>}
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Websites to search</h3>
        <p className="muted" style={{ margin: '4px 0 10px' }}>One website per line, or upload a CSV with a Website column. Up to {info?.max_sites || 100} at a time.</p>
        <div className="field"><textarea rows="6" placeholder={'acme.ng\nbetaltd.com\nhttps://www.gamma.co.ng'} value={text} onChange={(e) => setText(e.target.value)} /></div>
        <div className="row" style={{ marginBottom: 12 }}>
          <input type="file" accept=".csv,text/csv" onChange={readFile} />
          {fileName && <span className="muted">{fileName}</span>}
        </div>
        <Btn busyText="Starting..." disabled={!text.trim() && !csv} onClick={start}>Find emails</Btn>
        {rejected.length > 0 && (
          <p className="muted" style={{ marginTop: 10 }}>Skipped {rejected.length} that are not company websites: {rejected.slice(0, 5).map((r) => r.input).join(', ')}{rejected.length > 5 ? '...' : ''}</p>
        )}
        <div className="note" style={{ marginTop: 14 }}>
          <strong>How this stays safe</strong>
          <ul style={{ margin: '6px 0 0 18px' }}>
            <li>It only reads pages the site shows to everyone, follows the site's robots.txt, and waits 2 to 3 seconds between pages.</li>
            <li>It keeps the addresses a business prints on its own site: its own domain, and Gmail, Yahoo and similar inboxes. Addresses of other companies on the page (web designers, hosts) are ignored.</li>
            <li>It skips EU addresses (judged from the address ending, so a .com business in the EU can slip through: check before you send).</li>
            <li>Anyone who unsubscribed, bounced, or is already a contact is never added again.</li>
            <li>Prospects live on their own list and never mix with people who signed up.</li>
            <li>Every email you send must include a clear opt-out line and your business address.</li>
          </ul>
        </div>
      </div>

      {open?.job && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="between">
            <div>
              <h3>Search #{open.job.id} <span className={`pill ${open.job.status === 'done' ? 'green' : open.job.status === 'cancelled' ? 'gray' : 'live'}`}>{open.job.status}</span></h3>
              <p className="muted">{open.job.done_sites} of {open.job.total_sites} websites checked. {open.job.saved} new addresses saved. Started {when(open.job.created_at)}.</p>
            </div>
            {running && <Btn className="btn ghost sm" busyText="Stopping..." onClick={stop}>Stop</Btn>}
          </div>
          {running && <div style={{ height: 8, background: '#e8eef8', borderRadius: 99, margin: '12px 0' }}><div style={{ height: 8, width: `${pct}%`, background: 'var(--blue-bright)', borderRadius: 99, transition: 'width .4s' }} /></div>}

          <div className="row" style={{ margin: '12px 0' }}>
            {[['all', 'All'], ['saved', `Saved (${counts.saved || 0})`], ['skipped', 'Skipped']].map(([k, label]) => (
              <button key={k} className={`btn sm ${show === k ? '' : 'ghost'}`} onClick={() => setShow(k)}>{label}</button>
            ))}
          </div>

          <div className="table-wrap">
            <table className="stack">
              <thead><tr><th>Email</th><th>Website</th><th>Found on</th><th>Result</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const [label, tone] = LABEL[r.status] || [r.status, 'gray'];
                  return (
                    <tr key={r.id}>
                      <td data-label="Email"><strong>{r.email}</strong></td>
                      <td data-label="Website">{r.site_url.replace(/^https?:\/\//, '')}</td>
                      <td data-label="Found on"><a href={r.page_url} target="_blank" rel="noreferrer noopener">{new URL(r.page_url).pathname}</a></td>
                      <td data-label="Result"><span className={`pill ${tone}`}>{label}</span>{r.status !== 'saved' && <div className="muted" style={{ fontSize: 12 }}>{r.note}</div>}</td>
                      <td className="actions">{r.status === 'saved' && r.still_saved && <Btn className="btn danger sm" busyText="Removing..." onClick={remove(r)}>Remove</Btn>}{r.status === 'saved' && !r.still_saved && <span className="muted">Removed</span>}</td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan="5" className="muted">{running ? 'Searching...' : 'Nothing here.'}</td></tr>}
              </tbody>
            </table>
          </div>

          <details style={{ marginTop: 14 }}>
            <summary>Websites ({open.sites.length})</summary>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="stack">
                <thead><tr><th>Website</th><th>Status</th><th>Pages read</th><th>Note</th></tr></thead>
                <tbody>
                  {open.sites.map((s) => (
                    <tr key={s.id}><td data-label="Website">{s.url.replace(/^https?:\/\//, '')}</td><td data-label="Status">{SITE[s.status] || s.status}</td><td data-label="Pages read">{s.pages_checked}</td><td data-label="Note" className="muted">{s.note || ''}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}

      {jobs.length > 1 && (
        <div className="card">
          <h3>Earlier searches</h3>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="stack">
              <thead><tr><th>When</th><th>Websites</th><th>Saved</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}><td data-label="When">{when(j.created_at)}</td><td data-label="Websites">{j.done_sites} / {j.total_sites}</td><td data-label="Saved">{j.saved}</td><td data-label="Status">{j.status}</td>
                    <td className="actions"><button className="btn ghost sm" onClick={() => pick(j.id)}>View</button></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
