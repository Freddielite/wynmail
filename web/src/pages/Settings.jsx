import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, CopyBtn, useGuard } from '../ui.jsx';

export default function Settings({ admin }) {
  const guard = useGuard();
  const [form, setForm] = useState(null);
  const [keyInput, setKeyInput] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [hookSecret, setHookSecret] = useState('');
  const [clearHook, setClearHook] = useState(false);

  useEffect(() => { guard(async () => setForm(await api.workspace()))(); }, []);
  if (!form) return <p className="muted">Loading...</p>;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = guard(async () => {
    const body = {
      name: form.name, from_name: form.from_name, from_email: form.from_email, reply_to: form.reply_to,
      footer_address: form.footer_address, tracking_domain: form.tracking_domain
    };
    if (admin) {
      Object.assign(body, { sending_domain: form.sending_domain, provider: form.provider,
        rate_per_minute: Number(form.rate_per_minute), daily_limit: Number(form.daily_limit) });
    }
    if (keyInput.trim()) body.provider_api_key = keyInput.trim();
    if (clearKey) body.clear_provider_key = true;
    if (hookSecret.trim()) body.webhook_secret = hookSecret.trim();
    if (clearHook) body.clear_webhook_secret = true;
    setForm(await api.saveWorkspace(body));
    setKeyInput(''); setClearKey(false); setHookSecret(''); setClearHook(false);
    return 'Settings saved';
  });

  const domain = form.sending_domain || 'yourdomain.com';
  const hookUrl = `${api.base}/webhooks/resend/${form.id}`;
  const saveBtn = <Btn busyText="Saving..." onClick={save}>Save settings</Btn>;

  return (
    <>
      <h1>Settings</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Sender identity, tracking and sending limits for this workspace.</p>

      <div className="grid cols-2">
        <div className="card">
          <h3>Sender</h3>
          <div className="field" style={{ marginTop: 12 }}><label>Workspace name</label><input value={form.name || ''} onChange={set('name')} /></div>
          <div className="field">
            <label>Sending domain {!admin && '(approved by Wyntek)'}</label>
            <input placeholder="mail.clientdomain.com" value={form.sending_domain || ''} onChange={set('sending_domain')} disabled={!admin} />
          </div>
          <div className="field"><label>From name</label><input value={form.from_name || ''} onChange={set('from_name')} /></div>
          <div className="field"><label>From email (must use the sending domain)</label><input value={form.from_email || ''} onChange={set('from_email')} /></div>
          <div className="field"><label>Reply to</label><input value={form.reply_to || ''} onChange={set('reply_to')} /></div>
          <div className="field"><label>Footer postal address</label><input value={form.footer_address || ''} onChange={set('footer_address')} /></div>
          {saveBtn}
        </div>

        <div className="grid">
          <div className="card">
            <h3>Delivery</h3>
            <div className="field" style={{ marginTop: 12 }}><label>Tracking domain</label><input placeholder="track.clientdomain.com" value={form.tracking_domain || ''} onChange={set('tracking_domain')} /></div>
            <div className="row">
              <div className="field" style={{ flex: 1 }}><label>Emails per minute</label><input type="number" value={form.rate_per_minute} onChange={set('rate_per_minute')} disabled={!admin} /></div>
              <div className="field" style={{ flex: 1 }}><label>Daily limit</label><input type="number" value={form.daily_limit} onChange={set('daily_limit')} disabled={!admin} /></div>
            </div>
            <div className="field"><label>Provider</label>
              <select value={form.provider} onChange={set('provider')} disabled={!admin}>
                <option value="resend">Resend</option>
                <option value="console">Console (dry run)</option>
              </select>
            </div>
            <div className="field">
              <label>Provider API key</label>
              <input type="password" autoComplete="off" value={keyInput} onChange={(e) => setKeyInput(e.target.value)}
                placeholder={form.has_provider_key ? 'Saved. Type to replace.' : 'Leave blank to use the Wyntek shared key'} />
              {form.has_provider_key && (
                <label style={{ marginTop: 8, fontWeight: 500 }}>
                  <input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
                  Remove the saved key
                </label>
              )}
            </div>
            <div className="field" style={{ marginTop: 6 }}>
              <label>Bounce and spam tracking</label>
              {form.has_provider_key ? (
                <>
                  <p className="muted" style={{ margin: '0 0 8px' }}>In your Resend account add a webhook with this URL and the events <code>email.delivered</code>, <code>email.bounced</code> and <code>email.complained</code>. Then paste its signing secret here. Bounced and complaining addresses are blocked automatically.</p>
                  <div className="row"><input readOnly value={hookUrl} /><CopyBtn text={hookUrl} /></div>
                  <input type="password" autoComplete="off" style={{ marginTop: 8 }} value={hookSecret} onChange={(e) => setHookSecret(e.target.value)}
                    placeholder={form.has_webhook_secret ? 'Saved. Type to replace.' : 'whsec_...'} />
                  {form.has_webhook_secret && (
                    <label style={{ marginTop: 8, fontWeight: 500 }}>
                      <input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={clearHook} onChange={(e) => setClearHook(e.target.checked)} />
                      Remove the saved secret
                    </label>
                  )}
                </>
              ) : (
                <p className="muted" style={{ margin: 0 }}>Bounces and spam complaints are tracked for you on the Wyntek shared account. Addresses that bounce or complain are blocked from future sends.</p>
              )}
            </div>
            {saveBtn}
          </div>

          <div className="card">
            <h3>DNS checklist</h3>
            <p className="muted">Add these at your DNS host, then verify the domain with your provider.</p>
            <div className="table-wrap"><table className="stack">
              <thead><tr><th>Type</th><th>Host</th><th>Value</th></tr></thead>
              <tbody>
                <tr><td data-label="Type">TXT</td><td data-label="Host">{domain}</td><td data-label="Value">SPF record from your provider</td></tr>
                <tr><td data-label="Type">TXT</td><td data-label="Host">resend._domainkey.{domain}</td><td data-label="Value">DKIM key from your provider</td></tr>
                <tr><td data-label="Type">TXT</td><td data-label="Host">_dmarc.{domain}</td><td data-label="Value">v=DMARC1; p=none; rua=mailto:dmarc@{domain}</td></tr>
                <tr><td data-label="Type">CNAME</td><td data-label="Host">{form.tracking_domain || `track.${domain}`}</td><td data-label="Value">your Wynmail host</td></tr>
              </tbody>
            </table></div>
          </div>
        </div>
      </div>
    </>
  );
}
