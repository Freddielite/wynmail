import { useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard } from '../ui.jsx';

export default function ResetPassword() {
  const guard = useGuard();
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);

  const submit = guard(async () => {
    if (password.length < 8) throw new Error('Use at least 8 characters');
    if (password !== confirm) throw new Error('The two passwords do not match');
    await api.reset({ token, password });
    setDone(true);
    return 'Password set. You can sign in now';
  });

  return (
    <div className="auth-wrap">
      <div className="auth card">
        <div className="brand" style={{ color: 'var(--navy)' }}>
          <img src="/logo.svg" width="38" height="38" alt="" /> Wynmail
        </div>
        {!token ? (
          <>
            <h2>Link not valid</h2>
            <p className="muted" style={{ margin: '8px 0 20px' }}>This page needs the link from your email. Request a new one from the sign in page.</p>
            <a className="btn" href="/" style={{ display: 'inline-block', textDecoration: 'none' }}>Go to sign in</a>
          </>
        ) : done ? (
          <>
            <h2>All set</h2>
            <p className="muted" style={{ margin: '8px 0 20px' }}>Your password has been saved. Every older session was signed out.</p>
            <a className="btn" href="/" style={{ display: 'inline-block', textDecoration: 'none' }}>Sign in</a>
          </>
        ) : (
          <>
            <h2>Choose a new password</h2>
            <p className="muted" style={{ margin: '8px 0 20px' }}>Use at least 8 characters. This link works once.</p>
            <div className="field"><label>New password</label><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            <div className="field"><label>Repeat it</label><input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()} /></div>
            <Btn style={{ width: '100%' }} busyText="Saving..." onClick={submit}>Set password</Btn>
          </>
        )}
      </div>
    </div>
  );
}
