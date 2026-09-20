import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { api, store } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Contacts from './pages/Contacts.jsx';
import Templates from './pages/Templates.jsx';
import Campaigns from './pages/Campaigns.jsx';
import Settings from './pages/Settings.jsx';
import Clients from './pages/Clients.jsx';
import Api from './pages/Api.jsx';

function Shell({ user, workspaces, onLogout }) {
  const nav = useNavigate();
  const current = workspaces.find((w) => String(w.id) === String(store.workspaceId)) || workspaces[0];

  const switchWorkspace = (id) => { store.workspaceId = id; nav(0); };

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="brand-tile"><img src="/logo.svg" width="28" height="28" alt="" /></span> Wynmail
        </div>
        <nav className="nav">
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/contacts">Contacts</NavLink>
          <NavLink to="/templates">Templates</NavLink>
          <NavLink to="/campaigns">Campaigns</NavLink>
          <NavLink to="/api">API</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          {user?.is_admin && <NavLink to="/clients">Clients</NavLink>}
        </nav>
        <div className="side-foot">
          {workspaces.length > 1 && (
            <select
              className="ws-select"
              value={current?.id || ''}
              onChange={(e) => switchWorkspace(e.target.value)}
              style={{ marginBottom: 12, color: '#0f172a' }}
            >
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
          <div>{current?.name}</div>
          <div>{user?.email}</div>
          <button className="btn ghost sm signout" onClick={onLogout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard workspace={current} />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/api" element={<Api />} />
          <Route path="/settings" element={<Settings admin={!!user?.is_admin} />} />
          {user?.is_admin && <Route path="/clients" element={<Clients />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState({ loading: true, user: null, workspaces: [] });

  const load = async () => {
    if (!store.token) return setState({ loading: false, user: null, workspaces: [] });
    try {
      const { user, workspaces } = await api.me();
      if (!store.workspaceId && workspaces[0]) store.workspaceId = workspaces[0].id;
      setState({ loading: false, user, workspaces });
    } catch {
      store.token = null;
      setState({ loading: false, user: null, workspaces: [] });
    }
  };

  useEffect(() => { load(); }, []);

  const logout = () => { store.token = null; store.workspaceId = null; setState({ loading: false, user: null, workspaces: [] }); };

  if (state.loading) return <div className="auth-wrap muted">Loading Wynmail...</div>;
  if (!state.user) return <Login onAuthed={load} />;

  return (
    <BrowserRouter>
      <Shell user={state.user} workspaces={state.workspaces} onLogout={logout} />
    </BrowserRouter>
  );
}
