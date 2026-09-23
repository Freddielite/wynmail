import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { BarChart, Funnel, HBars } from '../charts.jsx';

const DEVICE = { mobile: 'Phone', desktop: 'Computer', tablet: 'Tablet', unknown: 'Unknown' };
const hour = (s) => { const d = new Date(`${s}:00:00Z`); return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${String(d.getUTCHours()).padStart(2, '0')}:00`; };

// The performance section of a campaign report: funnel, timeline, links and devices.
export default function CampaignAnalytics({ id }) {
  const [data, setData] = useState(null);
  useEffect(() => { setData(null); api.campaignAnalytics(id).then(setData).catch(() => setData(false)); }, [id]);
  if (data === false) return <p className="muted">Analytics could not be loaded.</p>;
  if (!data) return <p className="muted">Loading analytics...</p>;
  const s = data.summary;
  return (
    <div className="grid cols-2" style={{ margin: '12px 0 18px' }}>
      <div>
        <h4 style={{ margin: '0 0 8px' }}>Funnel</h4>
        <Funnel steps={[
          { label: 'Sent', value: s.sent }, { label: 'Delivered', value: s.delivered, note: s.sent ? `${Math.round((s.delivered / s.sent) * 100)}%` : '' },
          { label: 'Opened', value: s.opened, note: `${s.open_rate}%` }, { label: 'Clicked', value: s.clicked, note: `${s.click_rate}% (${s.click_to_open_rate}% of openers)` }
        ]} />
        <p className="muted" style={{ marginTop: 8 }}>{s.unsubscribed} unsubscribed, {s.bounced} bounced, {s.complained} reported spam.</p>
        <h4 style={{ margin: '16px 0 8px' }}>Where people opened</h4>
        <HBars rows={data.devices.map((d) => ({ label: DEVICE[d.device] || d.device, value: d.people }))} />
      </div>
      <div>
        <h4 style={{ margin: '0 0 8px' }}>Opens and clicks over time</h4>
        {data.series.length
          ? <BarChart points={data.series.map((p) => ({ label: hour(p.at), opened: p.opened, clicked: p.clicked }))} keys={['opened', 'clicked']} names={['Opened', 'Clicked']} colors={['#2f80ed', '#0f766e']} height={150} />
          : <p className="muted">No opens yet.</p>}
        <h4 style={{ margin: '16px 0 8px' }}>Links people clicked</h4>
        <HBars color="#0f766e" rows={data.links.map((l) => ({ label: l.url, value: l.people, suffix: l.people === 1 ? ' person' : ' people', sub: l.clicks > l.people ? `${l.clicks} clicks in total` : '' }))} />
      </div>
    </div>
  );
}
