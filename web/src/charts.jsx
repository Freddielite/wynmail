// Small charts drawn with plain SVG and CSS, so there is nothing extra to download.

export function BarChart({ points, keys, colors, names, height = 170 }) {
  const W = 640;
  const pad = { t: 10, r: 8, b: 26, l: 34 };
  const max = Math.max(1, ...points.flatMap((p) => keys.map((k) => p[k] || 0)));
  const step = (W - pad.l - pad.r) / Math.max(points.length, 1);
  const bw = Math.max(1.5, Math.min(18, (step - 3) / keys.length));
  const y = (v) => pad.t + (height - pad.t - pad.b) * (1 - v / max);
  const labelAt = new Set([0, Math.floor(points.length / 2), points.length - 1]);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" style={{ width: '100%', height: 'auto' }}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="#e2e8f0" strokeWidth="1" />
            <text x={pad.l - 6} y={y(max * f) + 4} textAnchor="end" fontSize="11" fill="#64748b">{Math.round(max * f)}</text>
          </g>
        ))}
        {points.map((p, i) => (
          <g key={p.label + i}>
            <title>{`${p.label}: ${keys.map((k, j) => `${names[j]} ${p[k] || 0}`).join(', ')}`}</title>
            {keys.map((k, j) => {
              const h = (height - pad.t - pad.b) * ((p[k] || 0) / max);
              const x = pad.l + i * step + (step - bw * keys.length) / 2 + j * bw;
              return <rect key={k} x={x} y={height - pad.b - h} width={bw} height={Math.max(h, 0)} rx="2" fill={colors[j]} />;
            })}
            {labelAt.has(i) && <text x={pad.l + i * step + step / 2} y={height - 8} textAnchor="middle" fontSize="11" fill="#64748b">{p.label}</text>}
          </g>
        ))}
      </svg>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginTop: 4 }}>
        {names.map((n, j) => <span key={n} className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: colors[j], display: 'inline-block' }} />{n}</span>)}
      </div>
    </div>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function Heatmap({ grid }) {
  const max = Math.max(1, ...grid.flat());
  return (
    <div className="heat">
      <div className="heatrow heathead"><span />{Array.from({ length: 24 }, (_, h) => <span key={h}>{h % 6 === 0 ? h : ''}</span>)}</div>
      {grid.map((row, d) => (
        <div className="heatrow" key={d}>
          <span className="heatlabel">{DAYS[d]}</span>
          {row.map((n, h) => <i key={h} title={`${DAYS[d]} ${String(h).padStart(2, '0')}:00, ${n} first ${n === 1 ? 'open' : 'opens'}`} style={{ background: n ? `rgba(29,78,216,${0.15 + 0.85 * (n / max)})` : '#f1f5f9' }} />)}
        </div>
      ))}
    </div>
  );
}

export function bestTime(grid) {
  let best = null;
  grid.forEach((row, d) => row.forEach((n, h) => { if (n > 0 && (!best || n > best.n)) best = { d, h, n }; }));
  return best ? `${DAYS[best.d]} around ${String(best.h).padStart(2, '0')}:00` : null;
}

export function HBars({ rows, color = '#2f80ed' }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div>
      {rows.map((r) => (
        <div key={r.label} style={{ marginBottom: 10 }}>
          <div className="between" style={{ fontSize: 14 }}><span style={{ overflowWrap: 'anywhere' }}>{r.label}</span><strong>{r.value}{r.suffix || ''}</strong></div>
          <div className="bar"><i style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: color }} /></div>
          {r.sub && <div className="muted" style={{ fontSize: 12 }}>{r.sub}</div>}
        </div>
      ))}
      {!rows.length && <p className="muted" style={{ margin: 0 }}>Nothing yet.</p>}
    </div>
  );
}

export function Funnel({ steps }) {
  const top = Math.max(1, steps[0]?.value || 1);
  return (
    <div>
      {steps.map((s) => (
        <div key={s.label} style={{ marginBottom: 8 }}>
          <div className="between" style={{ fontSize: 14 }}><span>{s.label}</span><span><strong>{s.value}</strong> <span className="muted">{s.note}</span></span></div>
          <div className="bar" style={{ height: 10 }}><i style={{ width: `${Math.max(1.5, (s.value / top) * 100)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}
