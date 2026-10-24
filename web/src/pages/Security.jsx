import { useEffect, useState } from 'react';
import { api, store } from '../api.js';
import { Btn, CopyBtn, useGuard } from '../ui.jsx';
import { SSO_ENABLED } from '../flags.js';

// Two-step sign-in, sign out everywhere, and (read only) the single sign-on values for the company's IT team.
export default function Security() {
  const guard = useGuard();
  const [mfa, setMfa] = useState(null);
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [off, setOff] = useState({ password: '', code: '' });
  const [sso, setSso] = useState(null);

  const load = async () => { setMfa(await api.mfaStatus()); };
  useEffect(() => { guard(load)(); if (SSO_ENABLED) api.sso().then(setSso).catch(() => {}); }, []);

  const start = guard(async () => setSetup(await api.mfaSetup()));
  const enable = guard(async () => {
    const r = await api.mfaEnable(code.trim());
    store.token = r.token; // other devices are signed out, this one stays
    setCodes(r.recovery_codes); setSetup(null); setCode('');
    await load();
    return 'Two-step sign-in is on';
  });
  const disable = guard(async () => {
    const r = await api.mfaDisable({ password: off.password, ...(/^[0-9 ]{6,7}$/.test(off.code) ? { code: off.code } : { recovery_code: off.code }) });
    store.token = r.token; setOff({ password: '', code: '' });
    await load();
    return 'Two-step sign-in is off';
  });
  const regen = guard(async () => {
    const r = await api.mfaRecoveryCodes({ password: off.password, ...(/^[0-9 ]{6,7}$/.test(off.code) ? { code: off.code } : { recovery_code: off.code }) });
    setCodes(r.recovery_codes);
    await load();
  });
  const everywhere = guard(async () => {
    if (!window.confirm('Sign out of every device, including phones and other browsers? You stay signed in here.')) return;
    const r = await api.logoutAll();
    store.token = r.token;
    return 'Every other device was signed out';
  });

  if (!mfa) return null;
  const codesText = codes ? codes.join('\n') : '';

  return (
    <div className="grid cols-2" style={{ marginTop: 20 }}>
      <div className="card">
        <h3>Two-step sign-in</h3>
        <p className="muted" style={{ margin: '4px 0 12px' }}>
          {mfa.enabled ? `On. ${mfa.recovery_codes_left} recovery codes left.` : 'Add a code from an authenticator app (Google Authenticator, Authy, 1Password) to your password.'}
        </p>

        {codes && (
          <div className="keybox" style={{ marginBottom: 12 }}>
            <strong>Save these recovery codes now.</strong> Each works once if you lose your phone. They are not shown again.
            <pre className="code" style={{ margin: '8px 0' }}>{codesText}</pre>
            <CopyBtn text={codesText} label="Copy codes" />{' '}
            <button className="btn ghost sm" onClick={() => setCodes(null)}>I saved them</button>
          </div>
        )}

        {!mfa.enabled && !setup && <Btn busyText="Starting..." onClick={start}>Set up two-step sign-in</Btn>}
        {!mfa.enabled && setup && (
          <>
            <p>1. In your authenticator app, add an account using this key (or open the link on your phone):</p>
            <div className="keybox" style={{ margin: '8px 0' }}>
              <div style={{ wordBreak: 'break-all' }}>{setup.secret}</div>
              <div style={{ marginTop: 8 }}><CopyBtn text={setup.secret} label="Copy key" /> <a className="btn ghost sm" href={setup.otpauth_url}>Open in app</a></div>
            </div>
            <p>2. Type the 6 digit code it shows:</p>
            <div className="row" style={{ marginTop: 8 }}>
              <input inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && enable()} />
              <Btn busyText="Checking..." onClick={enable}>Turn on</Btn>
            </div>
          </>
        )}

        {mfa.enabled && (
          <>
            <p className="muted" style={{ marginBottom: 8 }}>To turn it off or get new recovery codes, confirm with your password and a current code (or a recovery code).</p>
            <div className="field"><label>Password</label><input type="password" autoComplete="current-password" value={off.password} onChange={(e) => setOff({ ...off, password: e.target.value })} /></div>
            <div className="field"><label>Code or recovery code</label><input value={off.code} onChange={(e) => setOff({ ...off, code: e.target.value })} /></div>
            <div className="row">
              <Btn className="btn ghost" busyText="Working..." onClick={regen}>New recovery codes</Btn>
              <Btn className="btn danger" busyText="Turning off..." onClick={disable}>Turn off</Btn>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3>Sessions</h3>
        <p className="muted" style={{ margin: '4px 0 12px' }}>Lost a laptop or phone? Sign out of every device at once. You stay signed in here.</p>
        <Btn className="btn ghost" busyText="Signing out..." onClick={everywhere}>Sign out everywhere</Btn>

        {sso && (
          <div style={{ marginTop: 24 }}>
            <h3>Single sign-on</h3>
            {sso.enabled ? (
              <p className="muted" style={{ margin: '4px 0 8px' }}>On for {sso.domains.join(', ')}{sso.enforce ? '. Passwords are switched off for these addresses.' : '.'} People are added and removed by your identity provider (SCIM).</p>
            ) : (
              <p className="muted" style={{ margin: '4px 0 8px' }}>Not set up. Ask Wyntek to connect your identity provider (Okta, Entra ID, Google Workspace, OneLogin).</p>
            )}
            <div className="field"><label>Entity ID</label><input readOnly value={sso.sp_entity_id} /></div>
            <div className="field"><label>Reply URL (ACS)</label><input readOnly value={sso.acs_url} /></div>
            <div className="field"><label>SCIM base URL</label><input readOnly value={sso.scim_base_url} /></div>
          </div>
        )}
      </div>
    </div>
  );
}
