import { useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard } from '../ui.jsx';

const KINDS = [
  ['disposable', 'Disposable inboxes', 'Throwaway addresses nobody reads.', true],
  ['typo', 'Typos in the domain', 'Like gmial.com or yaho.com.', true],
  ['no_mx', 'Domains that cannot receive mail', 'They would bounce.', true],
  ['role', 'Shared inboxes', 'Like info@ or support@. Nobody owns them and complaints are common. Review these yourself.', false]
];

// Scans every subscribed contact for addresses that will hurt sender reputation.
export default function ListHealth({ canManage, onCleaned }) {
  const guard = useGuard();
  const [scan, setScan] = useState(null);

  const run = guard(async () => { setScan(await api.hygiene()); });
  const clean = guard(async () => {
    const kinds = KINDS.filter(([k, , , fixable]) => fixable && scan.counts[k] > 0).map(([k]) => k);
    const n = kinds.reduce((a, k) => a + scan.counts[k], 0);
    if (!window.confirm(`Block ${n} address${n === 1 ? '' : 'es'} that cannot work? They stay in your records but will never be emailed.`)) return;
    const r = await api.cleanHygiene(kinds);
    setScan(await api.hygiene());
    await onCleaned?.();
    return `${r.cleaned} address${r.cleaned === 1 ? '' : 'es'} blocked`;
  });
  const fixable = scan ? KINDS.filter(([k, , , f]) => f).reduce((a, [k]) => a + scan.counts[k], 0) : 0;

  return (
    <div className="card">
      <div className="between">
        <div><h3>List health</h3><p className="muted" style={{ marginTop: 2 }}>Find addresses that bounce or never read your email.</p></div>
        <Btn className="btn ghost sm" busyText="Scanning..." onClick={run}>{scan ? 'Scan again' : 'Scan my list'}</Btn>
      </div>
      {scan && (
        <div style={{ marginTop: 12 }}>
          <p className="muted" style={{ margin: '0 0 10px' }}>Checked {scan.total.toLocaleString()} subscribed contacts{scan.mx_checked ? ` across ${scan.domains_checked.toLocaleString()} domains` : ''}.{scan.truncated ? ' Some domains were skipped. Scan again later.' : ''}{!scan.mx_checked && ' Domain lookups are off on this server.'}</p>
          {KINDS.map(([k, label, hint]) => (
            <div className="checkitem" key={k}>
              <span className={`pill ${scan.counts[k] ? (k === 'role' ? 'amber' : 'red') : 'green'}`}>{scan.counts[k]}</span>
              <div><strong>{label}</strong><div className="muted">{scan.counts[k] ? `${hint} ${scan.samples[k].slice(0, 3).join(', ')}${scan.counts[k] > 3 ? ' and more' : ''}` : 'None found.'}</div></div>
            </div>
          ))}
          {fixable > 0 && canManage && <Btn className="btn danger sm" style={{ marginTop: 6 }} busyText="Blocking..." onClick={clean}>Block the {fixable} that cannot work</Btn>}
          {fixable > 0 && !canManage && <p className="muted">Ask the workspace owner to block these.</p>}
          {fixable === 0 && <p className="muted" style={{ marginTop: 6 }}>Your list looks clean.</p>}
        </div>
      )}
    </div>
  );
}
