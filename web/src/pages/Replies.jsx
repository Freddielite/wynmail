import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Btn, useGuard, usePolling, when } from '../ui.jsx';

const KIND = {
  reply: ['Reply', 'green'], unsubscribe: ['Asked to stop', 'red'], auto_reply: ['Out of office', 'gray'], bounce: ['Bounced', 'red'], bounce_soft: ['Delayed', 'amber']
};
const TABS = [['', 'All'], ['reply', 'Replies'], ['unsubscribe', 'Asked to stop'], ['bounce', 'Bounces'], ['auto_reply', 'Out of office']];

// What came back from prospects, read from your mailboxes. Answer replies in your mail app: Wynmail only shows them here.
export default function Replies() {
  const guard = useGuard();
  const [kind, setKind] = useState('');
  const [data, setData] = useState(null);
  const [denied, setDenied] = useState(false);
  const load = async () => {
    try { setData(await api.replies(kind)); } catch (err) { if (/permission/i.test(err.message)) setDenied(true); else throw err; }
  };
  useEffect(() => { guard(load)(); }, [kind]);
  usePolling(() => load().catch(() => {}), true, 30000);

  const done = (r) => guard(async () => { await api.replyHandled(r.id, !r.handled); await load(); });

  if (denied) return <div className="card"><h2>Replies</h2><p className="muted">You do not have permission to see replies. Ask the workspace owner.</p></div>;
  if (!data) return null;
  return (
    <>
      <div className="between" style={{ marginBottom: 6 }}>
        <div><h1>Replies</h1><p className="muted">Answers, removal requests and bounces from your prospects. Reply from your mail app (Zoho, Gmail).</p></div>
        {data.needs_attention > 0 && <span className="pill red">{data.needs_attention} to look at</span>}
      </div>
      <div className="row" style={{ margin: '12px 0' }}>
        {TABS.map(([k, label]) => <button key={k} className={`btn sm ${kind === k ? '' : 'ghost'}`} onClick={() => setKind(k)}>{label}</button>)}
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="stack">
            <thead><tr><th>From</th><th>What</th><th>They wrote</th><th>When</th><th></th></tr></thead>
            <tbody>
              {data.replies.map((r) => {
                const [label, tone] = KIND[r.kind] || [r.kind, 'gray'];
                return (
                  <tr key={r.id} style={{ opacity: r.handled ? 0.55 : 1 }}>
                    <td data-label="From"><strong>{r.company || r.from_email}</strong>{r.company && <div className="muted" style={{ fontSize: 12 }}>{r.from_email}</div>}</td>
                    <td data-label="What"><span className={`pill ${tone}`}>{label}</span></td>
                    <td data-label="They wrote">{r.snippet || <span className="muted">{r.subject}</span>}</td>
                    <td data-label="When">{when(r.received_at)}</td>
                    <td className="actions">
                      {r.contact_id && <Link className="btn ghost sm" to={`/contacts/${r.contact_id}`}>Contact</Link>}{' '}
                      {['reply', 'unsubscribe'].includes(r.kind) && <Btn className="btn ghost sm" busyText="..." onClick={done(r)}>{r.handled ? 'Reopen' : 'Done'}</Btn>}
                    </td>
                  </tr>
                );
              })}
              {!data.replies.length && <tr><td colSpan="5" className="muted">Nothing yet. Wynmail reads your mailboxes every couple of minutes.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
