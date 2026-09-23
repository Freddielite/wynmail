import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Btn, useGuard, when } from '../ui.jsx';

const statusClass = { subscribed: 'green', unsubscribed: 'amber', bounced: 'red', complained: 'red' };

function outcome(e) {
  if (e.complained_at) return ['reported spam', 'red'];
  if (e.bounced_at) return [e.bounce_type === 'Permanent' ? 'bounced' : 'soft bounce', e.bounce_type === 'Permanent' ? 'red' : 'amber'];
  if (e.unsubscribed_at) return ['unsubscribed', 'amber'];
  if (e.clicked_at) return ['clicked', 'green'];
  if (e.opened_at) return ['opened', 'green'];
  if (e.delivered_at) return ['delivered', 'gray'];
  return [e.status, e.status === 'failed' ? 'red' : 'gray'];
}

export default function ContactProfile() {
  const { id } = useParams();
  const nav = useNavigate();
  const guard = useGuard();
  const [data, setData] = useState(null);
  const [allLists, setAllLists] = useState([]);
  const [canManage, setCanManage] = useState(false);
  const [form, setForm] = useState(null);
  const [tag, setTag] = useState('');
  const [attr, setAttr] = useState({ key: '', value: '' });
  const [addList, setAddList] = useState('');

  const load = async () => {
    const d = await api.profile(id);
    setData(d);
    setForm({ first_name: d.contact.first_name || '', last_name: d.contact.last_name || '', tags: d.contact.tags || [], attributes: d.contact.attributes || {} });
  };
  useEffect(() => { guard(load)(); api.lists().then(setAllLists).catch(() => {}); api.members().then((m) => setCanManage(m.can_manage)).catch(() => {}); }, [id]);
  if (!data || !form) return <p className="muted">Loading...</p>;
  const c = data.contact;

  const save = guard(async () => { await api.updateProfile(id, form); await load(); return 'Contact saved'; });
  const addTag = () => { const t = tag.trim().toLowerCase(); if (t && !form.tags.includes(t)) setForm({ ...form, tags: [...form.tags, t] }); setTag(''); };
  const addAttr = () => {
    const key = attr.key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    if (key && attr.value.trim()) setForm({ ...form, attributes: { ...form.attributes, [key]: attr.value.trim() } });
    setAttr({ key: '', value: '' });
  };
  const join = guard(async () => { if (!addList) throw new Error('Choose a list'); await api.addToList(id, Number(addList)); setAddList(''); await load(); return 'Added to the list'; });
  const leave = (l) => guard(async () => { await api.removeFromList(id, l.id); await load(); return `Removed from ${l.name}`; });
  const unblock = guard(async () => {
    if (!window.confirm(`Unblock ${c.email}? Only do this if you know the address works and they want your emails.`)) return;
    await api.unblockContact(id, true); await load(); return 'They can receive emails again';
  });
  const remove = guard(async () => {
    if (!window.confirm(`Delete ${c.email} and their history? This cannot be undone.`)) return;
    await api.deleteContact(id); nav('/contacts'); return 'Contact deleted';
  });
  const memberOf = new Set(data.lists.map((l) => l.id));

  return (
    <>
      <p style={{ margin: '0 0 8px' }}><Link to="/contacts">Back to contacts</Link></p>
      <div className="between" style={{ marginBottom: 18 }}>
        <div><h1 style={{ overflowWrap: 'anywhere' }}>{c.email}</h1>
          <p className="muted">{[c.first_name, c.last_name].filter(Boolean).join(' ') || 'No name yet'} <span className={`pill ${statusClass[c.status] || 'gray'}`}>{c.status}</span></p></div>
        <div className="row">
          {canManage && ['bounced', 'complained'].includes(c.status) && <Btn className="btn ghost sm" busyText="Unblocking..." onClick={unblock}>Unblock</Btn>}
          <Btn className="btn danger sm" busyText="Deleting..." onClick={remove}>Delete contact</Btn>
        </div>
      </div>

      <div className="grid stats" style={{ marginBottom: 18 }}>
        {[['Emails received', data.stats.received], ['Opened', data.stats.opened], ['Clicked', data.stats.clicked]].map(([l, n]) => <div className="stat" key={l}><div className="n">{n}</div><div className="l">{l}</div></div>)}
      </div>

      <div className="grid cols-2">
        <div className="grid">
          <div className="card">
            <h3>Details</h3>
            <div className="row" style={{ margin: '12px 0', alignItems: 'flex-start' }}>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>First name</label><input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} /></div>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>Last name</label><input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} /></div>
            </div>
            <div className="field">
              <label>Tags</label>
              <div>{form.tags.map((t) => <span className="tagchip" key={t}>{t}<button type="button" aria-label={`Remove ${t}`} onClick={() => setForm({ ...form, tags: form.tags.filter((x) => x !== t) })}>x</button></span>)}</div>
              <div className="row"><input placeholder="Add a tag, like vip" value={tag} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTag()} /><button type="button" className="btn ghost sm" onClick={addTag}>Add tag</button></div>
            </div>
            <div className="field">
              <label>Custom fields (usable as {'{{company}}'} in emails)</label>
              {Object.entries(form.attributes).map(([k, v]) => (
                <div className="row" key={k} style={{ marginBottom: 6 }}>
                  <span style={{ minWidth: 90, fontWeight: 600 }}>{k}</span>
                  <input value={v} onChange={(e) => setForm({ ...form, attributes: { ...form.attributes, [k]: e.target.value } })} />
                  <button type="button" className="btn danger sm" onClick={() => { const a = { ...form.attributes }; delete a[k]; setForm({ ...form, attributes: a }); }}>Remove</button>
                </div>
              ))}
              <div className="row"><input placeholder="Field name" value={attr.key} onChange={(e) => setAttr({ ...attr, key: e.target.value })} /><input placeholder="Value" value={attr.value} onChange={(e) => setAttr({ ...attr, value: e.target.value })} /><button type="button" className="btn ghost sm" onClick={addAttr}>Add</button></div>
            </div>
            <Btn busyText="Saving..." onClick={save}>Save changes</Btn>
          </div>

          <div className="card">
            <h3>Lists</h3>
            <div style={{ margin: '10px 0' }}>
              {data.lists.map((l) => <span className="tagchip" key={l.id}>{l.name}<button type="button" aria-label={`Remove from ${l.name}`} onClick={leave(l)}>x</button></span>)}
              {!data.lists.length && <span className="muted">Not on any list.</span>}
            </div>
            <div className="row">
              <select value={addList} onChange={(e) => setAddList(e.target.value)}><option value="">Add to a list</option>{allLists.filter((l) => !memberOf.has(l.id)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
              <Btn className="btn ghost sm" busyText="Adding..." onClick={join}>Add</Btn>
            </div>
          </div>

          <div className="card">
            <h3>Consent</h3>
            <div className="table-wrap" style={{ marginTop: 8 }}><table><tbody>
              <tr><td className="muted">Joined</td><td>{when(c.created_at)}</td></tr>
              <tr><td className="muted">Source</td><td>{c.consent_source || 'unknown'}</td></tr>
              <tr><td className="muted">Consent given</td><td>{c.consent_at ? when(c.consent_at) : 'not recorded'}</td></tr>
              {c.consent_text && <tr><td className="muted">They agreed to</td><td>{c.consent_text}</td></tr>}
              {c.consent_ip && <tr><td className="muted">From address</td><td>{c.consent_ip}</td></tr>}
              {c.unsubscribed_at && <tr><td className="muted">Unsubscribed</td><td>{when(c.unsubscribed_at)}</td></tr>}
            </tbody></table></div>
          </div>
        </div>

        <div className="grid">
          <div className="card">
            <h3>Email history</h3>
            <div className="timeline" style={{ marginTop: 14 }}>
              {data.emails.map((e) => { const [label, cls] = outcome(e); return (
                <div key={e.id}>
                  <strong>{e.campaign_name || e.automation_name || 'Email'}</strong> <span className={`pill ${cls}`}>{label}</span>
                  <div className="muted">{e.campaign_subject || e.step_subject || ''}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{when(e.sent_at)}{e.open_count ? `, opened ${e.open_count}x` : ''}{e.click_count ? `, clicked ${e.click_count}x` : ''}{e.automation_name ? ', from an automation' : ''}</div>
                </div>
              ); })}
              {!data.emails.length && <span className="muted">No emails sent to this person yet.</span>}
            </div>
          </div>

          {(data.signups.length > 0 || data.automations.length > 0) && (
            <div className="card">
              <h3>Signups and automations</h3>
              <div style={{ marginTop: 8 }}>
                {data.signups.map((s) => <div key={s.id} className="muted" style={{ marginBottom: 6 }}>Signed up through <strong>{s.form_name}</strong> on {when(s.created_at)}{s.confirmed_at ? ', confirmed' : ', not confirmed'}</div>)}
                {data.automations.map((a, i) => <div key={i} className="muted" style={{ marginBottom: 6 }}>In automation <strong>{a.name}</strong>: {a.status === 'active' ? `${Math.min(a.current_step, a.total_steps)} of ${a.total_steps} sent` : a.status === 'completed' ? 'finished' : 'stopped'}</div>)}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
