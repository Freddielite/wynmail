import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api, store } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Contacts from './pages/Contacts.jsx';
import Templates from './pages/Templates.jsx';
import Campaigns from './pages/Campaigns.jsx';
import Settings from './pages/Settings.jsx';
import Clients from './pages/Clients.jsx';
import Api from './pages/Api.jsx';
import Team from './pages/Team.jsx';

function Shell({ user, workspaces, onLogout }) {
  const nav = useNavigate();
  const current = workspaces.find((w) => String(w.id) === String(store.workspaceId)) || workspaces[0];

  const navRef = useRef(null);
  // Edge fades on the phone menu grow as you scroll: the left one appears once you move away
  // from the start, the right one fades out as you reach the end.
  const updateFade = useCallback(() => {
    const n = navRef.current;
    if (!n) return;
    const left = Math.max(0, Math.min(n.scrollLeft, 36));
    const right = Math.max(0, Math.min(n.scrollWidth - n.clientWidth - n.scrollLeft, 36));
    n.style.setProperty('--fl', `${left}px`);
    n.style.setProperty('--fr', `${right}px`);
  }, []);
  useEffect(() => {
    updateFade();
    window.addEventListener('resize', updateFade);
    return () => window.removeEventListener('resize', updateFade);
  }, [updateFade]);

  const { pathname } = useLocation();
  // On phones the menu scrolls sideways, so keep the current page centred in view.
  useEffect(() => {
    const nav = document.querySelector('.nav');
    const active = nav?.querySelector('a.active');
    if (nav && active) nav.scrollTo({ left: active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2, behavior: 'smooth' });
  }, [pathname]);

  const switchWorkspace = (id) => { store.workspaceId = id; nav(0); };

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="brand-tile"><img src="/logo.svg" width="28" height="28" alt="" /></span> Wynmail
        </div>
        <nav className="nav" ref={navRef} onScroll={updateFade}>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/contacts">Contacts</NavLink>
          <NavLink to="/templates">Templates</NavLink>
          <NavLink to="/campaigns">Campaigns</NavLink>
          <NavLink to="/api">API</NavLink>
          <NavLink to="/team">Team</NavLink>
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
          <Route path="/team" element={<Team />} />
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
