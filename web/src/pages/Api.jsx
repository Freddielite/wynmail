import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, CodeBlock, CopyBtn, useGuard, usePolling, when } from '../ui.jsx';

const ENDPOINTS = [
  ['POST', '/v1/emails', 'Send one email to one person'],
  ['POST', '/v1/contacts', 'Add or update a contact, optionally into a list'],
  ['GET', '/v1/contacts/{email}', 'Look up a contact and their status'],
  ['POST', '/v1/contacts/{email}/unsubscribe', 'Unsubscribe a contact'],
  ['GET', '/v1/lists', 'List your lists and their sizes'],
  ['GET', '/v1/campaigns', 'List campaigns with sent, open and click counts'],
  ['GET', '/v1/campaigns/{id}', 'One campaign with its stats']
];

export default function Api() {
  const guard = useGuard();
  const [keys, setKeys] = useState([]);
  const [emails, setEmails] = useState([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null);

  const load = async () => {
    const [k, e] = await Promise.all([api.apiKeys(), api.apiEmails()]);
    setKeys(k); setEmails(e);
  };
  useEffect(() => { guard(load)(); }, []);
  usePolling(() => load().catch(() => {}), true, 15000);

  const create = guard(async () => {
    const res = await api.createApiKey({ name: name.trim() || 'My app' });
    setCreated(res); setName('');
    await load();
    return 'Key created. Copy it now, it is shown once';
  });

  const revoke = (k) => guard(async () => {
    if (!window.confirm(`Revoke "${k.name}"? Anything using it stops working immediately.`)) return;
    await api.revokeApiKey(k.id);
    if (created?.id === k.id) setCreated(null);
    await load();
    return 'Key revoked';
  });

  const base = `${api.base}/v1`;
  const KEY = created?.key || 'YOUR_API_KEY';

  const sendSample = `curl -X POST ${base}/emails \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "ada@example.com",
    "subject": "Your code is {{code}}",
    "html": "<p>Hi {{first_name}}, your code is <b>{{code}}</b></p>",
    "variables": { "first_name": "Ada", "code": "482913" }
  }'`;
  const contactSample = `curl -X POST ${base}/contacts \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{ "email": "ada@example.com", "first_name": "Ada", "list": "Newsletter" }'`;
  const unsubSample = `curl -X POST ${base}/contacts/ada@example.com/unsubscribe \\
  -H "Authorization: Bearer ${KEY}"`;
  const listSample = `curl ${base}/campaigns -H "Authorization: Bearer ${KEY}"`;

  return (
    <>
      <h1>API</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Send email and manage contacts from your own apps and websites.</p>

      <div className="grid cols-2">
        <div className="grid">
          <div className="card">
            <h3>API keys</h3>
            <p className="muted" style={{ margin: '4px 0 12px' }}>Each key only reaches this workspace. Keep keys on your server, never in a website or app that visitors can open.</p>
            <div className="row" style={{ marginBottom: 6 }}>
              <input placeholder="Key name, e.g. Website" value={name} onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && create()} />
              <Btn className="btn sm" busyText="Creating..." onClick={create}>Create key</Btn>
            </div>

            {created && (
              <div className="keybox">
                <div style={{ marginBottom: 8 }}><strong>{created.name}</strong> - copy this now, you will not see it again</div>
                <div>{created.key}</div>
                <div style={{ marginTop: 10 }}><CopyBtn text={created.key} label="Copy key" /></div>
              </div>
            )}

            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table className="stack">
                <thead><tr><th>Name</th><th>Key</th><th>Last used</th><th></th></tr></thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id}>
                      <td data-label="Name"><strong>{k.name}</strong></td>
                      <td data-label="Key"><code>{k.prefix}...</code></td>
                      <td data-label="Last used">{when(k.last_used_at)}</td>
                      <td className="actions"><Btn className="btn danger sm" busyText="Revoking..." onClick={revoke(k)}>Revoke</Btn></td>
                    </tr>
                  ))}
                  {!keys.length && <tr><td colSpan="4" className="muted">No keys yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h3>Recent API emails</h3>
            <p className="muted" style={{ margin: '4px 0 8px' }}>The last 25 emails sent through the API, so you can see what happened.</p>
            <div className="table-wrap">
              <table className="stack">
                <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
                <tbody>
                  {emails.map((m) => (
                    <tr key={m.id}>
                      <td data-label="When">{when(m.created_at)}</td>
                      <td data-label="To">{m.to_email}</td>
                      <td data-label="Subject">{m.subject}</td>
                      <td data-label="Status">
                        <span className={`pill ${m.status === 'sent' ? 'green' : m.status === 'failed' ? 'red' : 'gray'}`}>{m.status}</span>
                        {m.error && <div className="muted">{m.error}</div>}
                      </td>
                    </tr>
                  ))}
                  {!emails.length && <tr><td colSpan="4" className="muted">Nothing sent through the API yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="grid">
          <div className="card">
            <div className="codehead"><h3>Base URL</h3><CopyBtn text={base} /></div>
            <pre className="code">{base}</pre>
            <p className="muted" style={{ marginTop: 10 }}>Send your key as <code>Authorization: Bearer YOUR_API_KEY</code>. Requests are limited to 120 a minute per key, and single emails count toward your daily sending limit.</p>
          </div>

          <div className="card">
            <h3>Quick start</h3>
            {created && <p className="muted" style={{ margin: '4px 0 12px' }}>These examples already use your new key.</p>}
            <div style={{ marginTop: 12 }}>
              <CodeBlock title="Send an email" text={sendSample} />
              <p className="muted" style={{ margin: '-8px 0 18px' }}>Single emails have no unsubscribe footer and no link tracking. Use <code>template_id</code> instead of <code>html</code> to send a saved template. Addresses that bounced or reported spam are blocked with a 422.</p>
              <CodeBlock title="Add a contact" text={contactSample} />
              <CodeBlock title="Unsubscribe a contact" text={unsubSample} />
              <CodeBlock title="Read campaign stats" text={listSample} />
            </div>
          </div>

          <div className="card">
            <h3>Endpoints</h3>
            <div className="eplist">
              {ENDPOINTS.map(([m, p, d]) => (
                <div className="ep" key={m + p}>
                  <div className="epline"><span className="pill">{m}</span><code>{p}</code></div>
                  <div className="muted">{d}</div>
                </div>
              ))}
            </div>
            <p className="muted" style={{ marginTop: 10 }}>Errors come back as JSON like <code>{'{ "error": "..." }'}</code> with a clear message and the right status code.</p>
          </div>
        </div>
      </div>
    </>
  );
}
