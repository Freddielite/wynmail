import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useGuard, usePolling, when } from '../ui.jsx';

// How a subject line test is going, then which subject won.
export default function AbReport({ id }) {
  const guard = useGuard();
  const [r, setR] = useState(null);
  const load = async () => { try { setR(await api.campaignAb(id)); } catch { /* keep the last view */ } };
  useEffect(() => { guard(load)(); }, [id]);
  usePolling(load, !!r && r.state !== 'decided', 4000);
  if (!r || !r.enabled) return null;

  const metric = r.metric === 'clicks' ? 'click rate' : 'open rate';
  const rate = (v) => (r.metric === 'clicks' ? v.click_rate : v.open_rate);
  const col = (key, subject) => {
    const v = r[key], won = r.winner === key;
    return (
      <div className="card" style={{ flex: 1, margin: 0, borderColor: won ? '#0f766e' : undefined }}>
        <div className="between"><strong>Subject {key}</strong>{won && <span className="pill green">winner</span>}</div>
        <div className="muted" style={{ margin: '4px 0 10px' }}>{subject}</div>
        <div style={{ fontSize: 28, fontWeight: 700 }}>{rate(v)}%</div>
        <div className="muted">{metric}. {v.sent} sent, {v.opens} opened, {v.clicks} clicked</div>
      </div>
    );
  };

  return (
    <div style={{ margin: '12px 0 16px' }}>
      <div className="between" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Subject line test</h3>
        {r.state === 'not_started' && <span className="pill gray">not started</span>}
        {r.state === 'testing' && <span className="pill amber">{r.still_sending ? 'sending the test' : 'waiting for results'}</span>}
        {r.state === 'decided' && <span className="pill green">decided</span>}
      </div>
      <div className="row" style={{ alignItems: 'stretch' }}>{col('A', r.subject_a)}{col('B', r.subject_b)}</div>
      <p className="muted" style={{ marginTop: 8 }}>
        {r.state === 'not_started' && `Starts when you send. ${r.percent}% of the audience is the test group, split evenly. The winner is picked on ${metric} after ${r.wait_hours} hour${r.wait_hours === 1 ? '' : 's'}.`}
        {r.state === 'testing' && (r.still_sending ? `Sending to the test group of ${r.test_size} people.` : `Everyone in the test group has it. ${r.decides_at ? `The winner is picked ${when(r.decides_at)}.` : ''} ${r.waiting} people are waiting for it.`)}
        {r.state === 'decided' && `${r.tie ? 'Both did equally well, so the original subject A was used.' : `Subject ${r.winner} had the better ${metric}.`} It went to the ${r.waiting === 0 ? 'rest of the audience' : `${r.waiting} people still waiting`}. Decided ${when(r.decided_at)}.`}
      </p>
    </div>
  );
}
