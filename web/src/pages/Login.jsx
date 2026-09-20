import { useState } from 'react';
import { api, store } from '../api.js';
import { Btn } from '../ui.jsx';

export default function Login({ onAuthed }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', workspaceName: '' });
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const go = (m) => { setMode(m); setError(''); setSent(false); };

  const submit = async () => {
    setError('');
    try {
      if (mode === 'forgot') {
        if (!form.email.trim()) throw new Error('Enter your email address');
        await api.forgot(form.email.trim());
        setSent(true);
        return;
      }
      const res = mode === 'login'
        ? await api.login({ email: form.email, password: form.password })
        : await api.register(form);
      store.token = res.token;
      if (res.workspace) store.workspaceId = res.workspace.id;
      await onAuthed();
    } catch (err) {
      setError(err.message);
    }
  };

  const label = { login: 'Sign in', register: 'Create account', forgot: 'Send reset link' }[mode];
  const busy = { login: 'Signing in...', register: 'Creating account...', forgot: 'Sending...' }[mode];

  return (
    <div className="auth-wrap">
      <div className="auth card">
        <div className="brand" style={{ color: 'var(--navy)' }}>
          <img src="/logo.svg" width="38" height="38" alt="" /> Wynmail
        </div>
        <h2>{mode === 'forgot' ? 'Reset your password' : <>Email that <span className="highlight">lands</span>.</>}</h2>
        <p className="muted" style={{ marginBottom: 20 }}>
          {mode === 'forgot' ? 'Enter your email and we will send you a link to choose a new password.' : 'Campaigns, contacts and delivery reporting by Wyntek Technologies.'}
        </p>

        {mode !== 'forgot' && (
          <div className="tabs">
            <button className={mode === 'login' ? 'on' : ''} onClick={() => go('login')}>Sign in</button>
            <button className={mode === 'register' ? 'on' : ''} onClick={() => go('register')}>Create account</button>
          </div>
        )}

        {error && <div className="error">{error}</div>}
        {sent && <div className="ok">If that email has an account, a reset link is on its way. It expires in 1 hour.</div>}

        {mode === 'register' && (
          <>
            <div className="field"><label>Your name</label><input value={form.name} onChange={set('name')} /></div>
            <div className="field"><label>Workspace name</label><input placeholder="Client or company name" value={form.workspaceName} onChange={set('workspaceName')} /></div>
          </>
        )}
        <div className="field"><label>Email</label><input type="email" autoComplete="email" value={form.email} onChange={set('email')}
          onKeyDown={(e) => e.key === 'Enter' && mode === 'forgot' && submit()} /></div>
        {mode !== 'forgot' && (
          <div className="field"><label>Password</label>
            <input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={set('password')}
              onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </div>
        )}

        <Btn style={{ width: '100%' }} busyText={busy} onClick={submit}>{label}</Btn>

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          {mode === 'login' && <button className="linklike" onClick={() => go('forgot')}>Forgot password?</button>}
          {mode === 'forgot' && <button className="linklike" onClick={() => go('login')}>Back to sign in</button>}
        </div>
      </div>
    </div>
  );
}
