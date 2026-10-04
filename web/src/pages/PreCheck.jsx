import { Btn } from '../ui.jsx';

const levelPill = { fail: ['red', 'fix'], warn: ['amber', 'improve'], info: ['gray', 'note'], pass: ['green', 'ok'] };
const verdictText = {
  good: 'Ready to send',
  review: 'Worth a look before sending',
  risky: 'Fix these before sending'
};

// The result of the pre-send check: a score, then everything found, worst first.
export default function PreCheck({ result, onClose, onDeep }) {
  const { score, verdict, items, audience, fails, warnings } = result;
  const tone = verdict === 'good' ? '#0f766e' : verdict === 'review' ? '#b45309' : '#b91c1c';
  const circ = 2 * Math.PI * 34;
  return (
    <div className="card" id="precheck" style={{ marginTop: 18 }}>
      <div className="between" style={{ alignItems: 'flex-start' }}>
        <div className="scorewrap">
          <svg width="84" height="84" viewBox="0 0 84 84" role="img" aria-label={`Score ${score} out of 100`}>
            <circle cx="42" cy="42" r="34" fill="none" stroke="#e2e8f0" strokeWidth="8" />
            <circle cx="42" cy="42" r="34" fill="none" stroke={tone} strokeWidth="8" strokeLinecap="round"
              strokeDasharray={`${(score / 100) * circ} ${circ}`} transform="rotate(-90 42 42)" />
            <text x="42" y="48" textAnchor="middle" fontSize="22" fontWeight="700" fill={tone}>{score}</text>
          </svg>
          <div>
            <h3 style={{ margin: 0 }}>{verdictText[verdict]}</h3>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              {fails ? `${fails} to fix` : 'Nothing to fix'}{warnings ? `, ${warnings} to improve` : ''}
              {audience !== null && audience !== undefined ? `. ${audience.toLocaleString()} ${audience === 1 ? 'person' : 'people'} would receive this.` : '.'}
            </p>
          </div>
        </div>
        <div className="row">
          {onDeep && <Btn className="btn ghost sm" busyText="Checking links..." onClick={onDeep}>Also check links</Btn>}
          <button className="btn ghost sm" onClick={onClose}>Close</button>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        {items.map((i) => (
          <div className="checkitem" key={i.id}>
            <span className={`pill ${levelPill[i.level][0]}`}>{levelPill[i.level][1]}</span>
            <div><strong>{i.title}</strong>{i.detail && <div className="muted">{i.detail}</div>}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
