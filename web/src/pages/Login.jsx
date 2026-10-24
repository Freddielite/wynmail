import { useState } from 'react';
import { api, store } from '../api.js';
import { Btn } from '../ui.jsx';

const SSO_MESSAGES = {
  not_configured: 'Single sign-on is not set up for that email address. Sign in with your password instead, or ask Wyntek to set up SSO for your company.',
  bad_email: 'Enter your full work email first, then choose Sign in with SSO.',
  invalid_response: 'Your company\'s sign-in answer could not be verified. Try again, and tell your IT team if it keeps happening.',
  email_not_allowed: 'That account is not allowed to sign in here. Ask your IT team to check your email domain.',
  not_configured_workspace: 'Single sign-on is switched off for this company.'
};

export default function Login({ onAuthed }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', workspaceName: '' });
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [mfa, setMfa] = useState(null); // { mfa_token } while the second step is pending
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const ssoError = new URLSearchParams(window.location.search).get('sso_error');

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
      if (res.mfa_required) { setMfa(res); setCode(''); return; }
      store.token = res.token;
      if (res.workspace) store.workspaceId = res.workspace.id;
      await onAuthed();
    } catch (err) {
      setError(err.message);
    }
  };

  const finishMfa = async () => {
    setError('');
    try {
      const res = await api.loginMfa({ mfa_token: mfa.mfa_token, ...(useRecovery ? { recovery_code: code } : { code }) });
      store.token = res.token;
      await onAuthed();
    } catch (err) {
      setError(err.message);
      if (/expired/i.test(err.message)) setMfa(null);
    }
  };
  const sso = () => {
    if (!form.email.trim()) return setError('Enter your work email first');
    window.location.href = api.ssoStartUrl(form.email.trim());
  };

  if (mfa) {
    return (
      <div className="auth-wrap">
        <div className="auth card">
          <div className="brand" style={{ color: 'var(--navy)' }}><img src="/logo.svg" width="38" height="38" alt="" /> Wynmail</div>
          <h2>Two-step sign-in</h2>
          <p className="muted" style={{ marginBottom: 20 }}>
            {useRecovery ? 'Enter one of your recovery codes. Each works once.' : 'Enter the 6 digit code from your authenticator app.'}
          </p>
          {error && <div className="error">{error}</div>}
          <div className="field"><label>{useRecovery ? 'Recovery code' : 'Code'}</label>
            <input autoFocus inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && finishMfa()} placeholder={useRecovery ? 'xxxxx-xxxxx' : '123456'} /></div>
          <Btn style={{ width: '100%' }} busyText="Checking..." onClick={finishMfa}>Continue</Btn>
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button className="linklike" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(''); }}>
              {useRecovery ? 'Use my authenticator app' : 'I lost my phone'}
            </button>{' | '}
            <button className="linklike" onClick={() => { setMfa(null); setError(''); }}>Start again</button>
          </div>
        </div>
      </div>
    );
  }

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
        {!error && ssoError && <div className="error">{SSO_MESSAGES[ssoError] || 'Single sign-on did not work. Try again or ask your IT team.'}</div>}
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
          {mode === 'login' && <><button className="linklike" onClick={sso}>Sign in with SSO</button>{' | '}<button className="linklike" onClick={() => go('forgot')}>Forgot password?</button></>}
          {mode === 'forgot' && <button className="linklike" onClick={() => go('login')}>Back to sign in</button>}
        </div>
      </div>
    </div>
  );
}
