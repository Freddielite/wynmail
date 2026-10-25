import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { usePolling, when } from '../ui.jsx';

// Bell in the sidebar: held campaigns, paused sends and the like. Checks once a minute while the tab is open.
export default function Bell() {
  const [data, setData] = useState({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const load = () => api.notifications().then(setData).catch(() => {});
  useEffect(() => { load(); }, []);
  usePolling(load, true, 60000);

  const toggle = async () => {
    setOpen(!open);
    if (!open && data.unread) { await api.readNotifications().catch(() => {}); setData({ ...data, unread: 0 }); }
  };

  return (
    <div className="bell-wrap" style={{ marginTop: 10 }}>
      <button className="btn ghost sm" onClick={toggle} style={{ width: '100%' }}>
        Notifications{data.unread > 0 && <span className="pill red" style={{ marginLeft: 8 }}>{data.unread}</span>}
      </button>
      {open && (
        <div className="card" style={{ marginTop: 8, color: '#0f172a', maxHeight: 320, overflow: 'auto' }}>
          {data.items.length === 0 && <div className="muted">Nothing yet.</div>}
          {data.items.map((n) => (
            <div key={n.id} style={{ marginBottom: 12 }}>
              <strong>{n.title}</strong>
              <div className="muted" style={{ fontSize: 12 }}>{when(n.created_at)}</div>
              {n.body && <div style={{ fontSize: 13, marginTop: 4 }}>{n.body}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
