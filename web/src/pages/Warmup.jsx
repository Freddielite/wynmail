import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard, when } from '../ui.jsx';

// Warm-up status for the workspace. Admins start, stop and tune it. Everyone can see where it stands.
export default function Warmup({ admin }) {
  const guard = useGuard();
  const [w, setW] = useState(null);
  const [volume, setVolume] = useState('50');
  const [growth, setGrowth] = useState('1.6');
  const load = async () => { const r = await api.warmup(); setW(r); setVolume(String(r.start_volume)); setGrowth(String(r.growth)); };
  useEffect(() => { guard(load)(); }, []);
  if (!w) return null;

  const apply = (body, msg) => guard(async () => { await api.saveWorkspace(body); await load(); return msg; });
  const start = apply({ warmup_enabled: true, warmup_start_volume: Number(volume), warmup_growth: Number(growth), warmup_restart: true }, 'Warm-up started');
  const stop = apply({ warmup_enabled: false }, 'Warm-up stopped. The full daily limit applies');
  const save = apply({ warmup_start_volume: Number(volume), warmup_growth: Number(growth) }, 'Warm-up plan saved');
  const restart = apply({ warmup_restart: true }, 'Warm-up restarted from day 1');
  const pct = w.today_cap ? Math.min(100, Math.round((w.sent_today / w.today_cap) * 100)) : 0;

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="between">
        <div><h3>Warm-up</h3><p className="muted" style={{ marginTop: 2 }}>A new sending domain has no reputation yet. Warm-up raises the daily volume a little each day so inboxes learn to trust it.</p></div>
        {w.enabled && <span className={`pill ${w.done ? 'green' : 'amber'}`}>{w.done ? 'complete' : `day ${w.day}`}</span>}
      </div>

      {w.enabled ? (
        <>
          <div style={{ margin: '14px 0 6px' }}>
            <strong>{w.sent_today.toLocaleString()}</strong> of {w.today_cap.toLocaleString()} sent today
            {w.today_cap < w.planned_cap && <span className="muted"> (plan was {w.planned_cap.toLocaleString()})</span>}
          </div>
          <div className="bar"><i style={{ width: `${pct}%` }} /></div>
          {w.hold && <div className="checkitem" style={{ marginTop: 12 }}><span className="pill amber">paused</span><div><strong>Growth is on hold</strong><div className="muted">{w.hold}. Volume stays level until it recovers.</div></div></div>}
          {w.done && <p className="muted" style={{ marginTop: 10 }}>The plan has reached your daily limit of {w.daily_limit.toLocaleString()}. Nothing more to do.</p>}
          {!w.done && (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead><tr><th>Day</th>{w.schedule.slice(0, 8).map((d) => <th key={d.day}>{d.day}</th>)}</tr></thead>
                <tbody><tr><td className="muted">Emails</td>{w.schedule.slice(0, 8).map((d) => <td key={d.day}>{d.cap.toLocaleString()}</td>)}</tr></tbody>
              </table>
            </div>
          )}
          <p className="muted" style={{ margin: '10px 0' }}>Started {when(w.started_at)}. Campaigns and automations follow the cap and send to your most engaged people first. Password resets, confirmations and API emails are not held back.</p>
        </>
      ) : (
        <p className="muted" style={{ margin: '12px 0' }}>Warm-up is off, so the full daily limit of {w.daily_limit.toLocaleString()} applies from the first send. {admin ? 'Turn it on for any new sending domain.' : 'Ask Wyntek to turn it on if this domain is new.'}</p>
      )}

      {admin && (
        <>
          <div className="row" style={{ alignItems: 'flex-end', marginTop: 8 }}>
            <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>Day 1 emails</label><input type="number" min="1" max="5000" value={volume} onChange={(e) => setVolume(e.target.value)} /></div>
            <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>Growth per day (1.1 to 3)</label><input type="number" step="0.1" min="1.1" max="3" value={growth} onChange={(e) => setGrowth(e.target.value)} /></div>
          </div>
          <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
            {w.enabled ? (<>
              <Btn className="btn sm" busyText="Saving..." onClick={save}>Save plan</Btn>
              <Btn className="btn ghost sm" busyText="Restarting..." onClick={restart}>Restart from day 1</Btn>
              <Btn className="btn ghost sm" busyText="Stopping..." onClick={stop}>Stop warm-up</Btn>
            </>) : <Btn className="btn sm" busyText="Starting..." onClick={start}>Start warm-up</Btn>}
          </div>
        </>
      )}
    </div>
  );
}
