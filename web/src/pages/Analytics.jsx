import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useGuard } from '../ui.jsx';
import { BarChart, Heatmap, bestTime } from '../charts.jsx';

const short = (d) => new Date(`${d}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });

export default function Analytics() {
  const guard = useGuard();
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);

  useEffect(() => { guard(async () => setData(await api.analyticsOverview(days)))(); }, [days]);
  if (!data) return <p className="muted">Loading...</p>;

  const t = data.totals;
  const best = bestTime(data.opens_grid);
  const cards = [
    { l: 'Emails sent', n: t.sent }, { l: 'Open rate', n: `${t.open_rate}%` }, { l: 'Click rate', n: `${t.click_rate}%` },
    { l: 'Unsubscribed', n: `${t.unsubscribe_rate}%` }, { l: 'Bounced', n: `${t.bounce_rate}%` }
  ];

  return (
    <>
      <div className="between" style={{ marginBottom: 20 }}>
        <div><h1>Analytics</h1><p className="muted">How your emails are doing.</p></div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ maxWidth: 190 }}>
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select>
      </div>

      <div className="grid stats">
        {cards.map((c) => <div className="stat" key={c.l}><div className="n">{c.n}</div><div className="l">{c.l}</div></div>)}
      </div>
      <p className="muted" style={{ marginTop: 10 }}>Rates count people, not repeat opens. Some mail apps open emails automatically to protect privacy, so opens can look higher than real reading. Clicks are the more reliable signal.</p>

      <div className="card" style={{ marginTop: 18 }}>
        <h3>Sent, opened and clicked by day</h3>
        <p className="muted" style={{ margin: '4px 0 10px' }}>Opens and clicks are counted on the day each person first opened or clicked.</p>
        <BarChart points={data.series.map((d) => ({ label: short(d.day), sent: d.sent, opened: d.opened, clicked: d.clicked }))}
          keys={['sent', 'opened', 'clicked']} names={['Sent', 'Opened', 'Clicked']} colors={['#cbd5e1', '#2f80ed', '#0f766e']} />
      </div>

      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <div className="card">
          <h3>When people open</h3>
          <p className="muted" style={{ margin: '4px 0 12px' }}>{best ? `Most first opens happen on ${best}. Try sending shortly before then.` : 'Not enough opens yet to see a pattern.'} Times are in your own time zone.</p>
          <Heatmap grid={data.opens_grid} />
        </div>
        <div className="card">
          <h3>Recent campaigns</h3>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="stack">
              <thead><tr><th>Campaign</th><th>Sent</th><th>Opened</th><th>Clicked</th></tr></thead>
              <tbody>
                {data.campaigns.map((c) => (
                  <tr key={c.id}>
                    <td className="title"><strong>{c.name}</strong><div className="muted">{c.subject}</div></td>
                    <td data-label="Sent">{c.sent}</td>
                    <td data-label="Opened">{c.open_rate}%</td>
                    <td data-label="Clicked">{c.click_rate}%</td>
                  </tr>
                ))}
                {!data.campaigns.length && <tr><td colSpan="4" className="muted">No campaigns sent in this period.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
