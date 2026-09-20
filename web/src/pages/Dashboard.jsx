import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useGuard, usePolling } from '../ui.jsx';

const rate = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '0%');

export default function Dashboard({ workspace }) {
  const guard = useGuard();
  const [stats, setStats] = useState(null);

  const load = async () => setStats(await api.stats());
  useEffect(() => { guard(load)(); }, []);
  usePolling(() => load().catch(() => {}), !!stats && stats.queued > 0, 4000);

  if (!stats) return <p className="muted">Loading...</p>;

  const cards = [
    { l: 'Subscribers', n: stats.subscribers },
    { l: 'Lists', n: stats.lists },
    { l: 'Campaigns', n: stats.campaigns },
    { l: 'Emails sent', n: stats.sent },
    { l: 'Open rate', n: rate(stats.opened, stats.sent) },
    { l: 'Click rate', n: rate(stats.clicked, stats.sent) },
    { l: 'In queue', n: stats.queued },
    { l: 'Sent today', n: `${stats.sent_today} / ${stats.daily_limit}` }
  ];

  return (
    <>
      <div className="between" style={{ marginBottom: 20 }}>
        <div>
          <h1>Dashboard</h1>
          <p className="muted">{workspace?.name} sending as {workspace?.from_email || 'no sender set'}</p>
        </div>
      </div>

      <div className="grid stats">
        {cards.map((c) => (
          <div className="stat" key={c.l}>
            <div className="n">{c.n}</div>
            <div className="l">{c.l}</div>
          </div>
        ))}
      </div>

      {(!workspace?.from_email || !workspace?.sending_domain || !workspace?.footer_address) && (
        <div className="card" style={{ marginTop: 22 }}>
          <h3>Finish setup</h3>
          <p className="muted">Set a from address and footer postal address in Settings, and have Wyntek approve your sending domain, before your first send.</p>
        </div>
      )}
    </>
  );
}
