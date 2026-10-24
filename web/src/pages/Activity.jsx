import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard, when } from '../ui.jsx';

const KIND = { list: 'List', template: 'Template', contact: 'Contact' };

// Lists, templates and contacts that were deleted in the last 30 days, with a one click restore.
export function Deleted({ canErase }) {
  const guard = useGuard();
  const [rows, setRows] = useState(null);
  const load = async () => setRows(await api.deleted());
  useEffect(() => { guard(load)(); }, []);

  const restore = (r) => guard(async () => { await api.restoreDeleted(r.id); await load(); return `${KIND[r.kind]} restored`; });
  const erase = (r) => guard(async () => {
    if (!window.confirm(`Erase ${r.label} for good? This cannot be undone.`)) return;
    await api.eraseDeleted(r.id); await load(); return 'Erased';
  });

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <h3>Recently deleted</h3>
      <p className="muted" style={{ margin: '4px 0 10px' }}>Deleted lists, templates and contacts are kept for 30 days, then removed for good.</p>
      {rows && rows.length === 0 && <p className="muted">Nothing deleted recently.</p>}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table className="stack">
            <thead><tr><th>What</th><th>Deleted</th><th>Gone for good</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="What"><span className="pill gray">{KIND[r.kind] || r.kind}</span> <strong>{r.label}</strong></td>
                  <td data-label="Deleted">{when(r.deleted_at)}</td>
                  <td data-label="Gone for good">{when(r.purge_after)}</td>
                  <td className="actions">
                    <Btn className="btn sm" busyText="Restoring..." onClick={restore(r)}>Restore</Btn>{' '}
                    {canErase && <Btn className="btn danger sm" busyText="Erasing..." onClick={erase(r)}>Erase now</Btn>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const LABELS = {
  'login.ok': 'Signed in', 'login.failed': 'Failed sign-in', 'mfa.enabled': 'Turned on two-step sign-in', 'mfa.disabled': 'Turned off two-step sign-in',
  'mfa.recovery_used': 'Signed in with a recovery code', 'sessions.revoked_all': 'Signed out everywhere', 'password.changed': 'Changed password',
  'password.reset': 'Reset password', 'workspace.settings_updated': 'Changed settings', 'apikey.created': 'Created an API key', 'apikey.revoked': 'Revoked an API key',
  'member.added': 'Added a person', 'member.removed': 'Removed a person', 'member.permissions_changed': 'Changed a person\'s permissions',
  'list.deleted': 'Deleted a list', 'template.deleted': 'Deleted a template', 'contact.deleted': 'Deleted a contact', 'contact.erased': 'Erased a contact for good',
  'record.restored': 'Restored a deleted item', 'record.erased': 'Erased a deleted item', 'contacts.exported': 'Exported contacts', 'campaign.exported': 'Exported a report',
  'campaign.risk_override': 'Sent a held campaign anyway', 'campaign.resumed': 'Resumed a paused campaign', 'sso.login': 'Signed in with SSO', 'sso.config_changed': 'Changed SSO settings',
  'scim.user_created': 'IT added a person', 'scim.user_deactivated': 'IT removed a person', 'scim.user_activated': 'IT restored a person'
};

export function ActivityLog() {
  const guard = useGuard();
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(false);
  const load = (before) => guard(async () => {
    const r = await api.audit(before);
    setRows((cur) => (before ? [...cur, ...r] : r)); setMore(r.length >= 100);
  })();
  useEffect(() => { load(); }, []);

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <h3>Activity log</h3>
      <p className="muted" style={{ margin: '4px 0 10px' }}>Who did what in this workspace. Passwords and keys are never recorded.</p>
      <div className="table-wrap">
        <table className="stack">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>From</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-label="When">{when(r.created_at)}</td>
                <td data-label="Who">{r.actor_email || 'Your identity provider'}</td>
                <td data-label="What">{LABELS[r.action] || r.action}</td>
                <td data-label="From" className="muted">{r.ip}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="4" className="muted">Nothing recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {more && <div style={{ marginTop: 10 }}><button className="btn ghost sm" onClick={() => load(rows[rows.length - 1].id)}>Older</button></div>}
    </div>
  );
}
