import { useState } from 'react';
import { api, store } from '../api.js';

export default function Login({ onAuthed }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', workspaceName: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const res = mode === 'login'
        ? await api.login({ email: form.email, password: form.password })
        : await api.register(form);
      store.token = res.token;
      if (res.workspace) store.workspaceId = res.workspace.id;
      await onAuthed();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth card">
        <div className="brand" style={{ color: 'var(--navy)' }}>
          <span className="brand-dot" style={{ background: 'var(--brand-gradient)', color: '#fff' }}>W</span> Wynmail
        </div>
        <h2>Email that <span className="highlight">lands</span>.</h2>
        <p className="muted" style={{ marginBottom: 20 }}>Campaigns, contacts and delivery reporting by Wyntek Technologies.</p>

        <div className="tabs">
          <button className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>Sign in</button>
          <button className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>Create account</button>
        </div>

        {error && <div className="error">{error}</div>}

        {mode === 'register' && (
          <>
            <div className="field"><label>Your name</label><input value={form.name} onChange={set('name')} /></div>
            <div className="field"><label>Workspace name</label><input placeholder="Client or company name" value={form.workspaceName} onChange={set('workspaceName')} /></div>
          </>
        )}
        <div className="field"><label>Email</label><input type="email" value={form.email} onChange={set('email')} /></div>
        <div className="field"><label>Password</label><input type="password" value={form.password} onChange={set('password')} onKeyDown={(e) => e.key === 'Enter' && submit()} /></div>

        <button className="btn" style={{ width: '100%' }} disabled={busy} onClick={submit}>
          {busy ? 'Please wait...' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </div>
    </div>
  );
}
