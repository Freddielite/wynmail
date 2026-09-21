import { BLOCK_LABELS, FONT_LABELS, safeUrl } from './render.js';

const Row = ({ label, children }) => <div className="field"><label>{label}</label>{children}</div>;

function Color({ value, onChange, none }) {
  const v = value || '';
  return (
    <div className="colorrow">
      <input type="color" aria-label="Pick a color" value={/^#[0-9a-f]{6}$/i.test(v) ? v : '#000000'} onChange={(e) => onChange(e.target.value)} />
      <input value={v} placeholder={none ? 'none' : '#000000'} onChange={(e) => onChange(e.target.value)} />
      {none && v && <button type="button" className="btn ghost sm" onClick={() => onChange('')}>Clear</button>}
    </div>
  );
}

function Slider({ value, min, max, onChange, unit = 'px' }) {
  return (
    <div className="sliderrow">
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span>{value}{unit}</span>
    </div>
  );
}

function Align({ value, onChange }) {
  return (
    <div className="alignrow">
      {['left', 'center', 'right'].map((a) => (
        <button type="button" key={a} className={value === a ? 'on' : ''} onClick={() => onChange(a)}>{a[0].toUpperCase() + a.slice(1)}</button>
      ))}
    </div>
  );
}

function MergeInsert({ onInsert }) {
  return (
    <select value="" onChange={(e) => e.target.value && onInsert(e.target.value)} aria-label="Insert a personal field">
      <option value="">Insert a personal field</option>
      <option value="{{first_name|there}}">First name (or "there")</option>
      <option value="{{last_name}}">Last name</option>
      <option value="{{email}}">Email address</option>
    </select>
  );
}

const SHAPES = [['Square', 0], ['Rounded', 8], ['Pill', 999]];

function Fields({ block, set }) {
  const p = block.props;
  switch (block.type) {
    case 'heading':
      return (<>
        <Row label="Heading text"><input value={p.text} onChange={(e) => set({ text: e.target.value })} /><MergeInsert onInsert={(m) => set({ text: `${p.text}${m}` })} /></Row>
        <Row label="Size"><select value={p.level} onChange={(e) => set({ level: Number(e.target.value) })}><option value={1}>Large</option><option value={2}>Medium</option><option value={3}>Small</option></select></Row>
        <Row label="Alignment"><Align value={p.align} onChange={(align) => set({ align })} /></Row>
        <Row label="Color"><Color value={p.color} none onChange={(color) => set({ color })} /></Row>
      </>);
    case 'text':
      return (<>
        <Row label="Text">
          <textarea rows="8" value={p.text} onChange={(e) => set({ text: e.target.value })} />
          <div className="muted">Blank line starts a new paragraph. <code>**bold**</code> <code>*italic*</code> <code>[link text](https://...)</code></div>
          <MergeInsert onInsert={(m) => set({ text: `${p.text}${m}` })} />
        </Row>
        <Row label="Text size (0 uses the email default)"><Slider value={p.size || 0} min={0} max={28} onChange={(size) => set({ size })} /></Row>
        <Row label="Alignment"><Align value={p.align} onChange={(align) => set({ align })} /></Row>
        <Row label="Color"><Color value={p.color} none onChange={(color) => set({ color })} /></Row>
      </>);
    case 'image':
      return (<>
        <Row label="Picture web address"><input value={p.src} placeholder="https://example.com/photo.jpg" onChange={(e) => set({ src: e.target.value })} />
          <div className="muted">Paste the address of a picture already online. Uploading pictures comes later.</div></Row>
        <Row label="Description for screen readers"><input value={p.alt} onChange={(e) => set({ alt: e.target.value })} /></Row>
        <Row label="Click goes to (optional)"><input value={p.link} placeholder="https://" onChange={(e) => set({ link: e.target.value })} /></Row>
        <Row label="Width"><Slider value={p.width} min={20} max={100} unit="%" onChange={(width) => set({ width })} /></Row>
        <Row label="Alignment"><Align value={p.align} onChange={(align) => set({ align })} /></Row>
        <Row label="Rounded corners"><Slider value={p.radius} min={0} max={40} onChange={(radius) => set({ radius })} /></Row>
      </>);
    case 'button':
      return (<>
        <Row label="Button text"><input value={p.label} onChange={(e) => set({ label: e.target.value })} /></Row>
        <Row label="Link"><input value={p.url} placeholder="https://" onChange={(e) => set({ url: e.target.value })} />
          {!safeUrl(p.url) && <div className="muted" style={{ color: '#b91c1c' }}>This button has no link yet, so it will not go anywhere.</div>}</Row>
        <Row label="Button color"><Color value={p.buttonBg} onChange={(buttonBg) => set({ buttonBg })} /></Row>
        <Row label="Text color"><Color value={p.color} onChange={(color) => set({ color })} /></Row>
        <Row label="Shape"><div className="alignrow">{SHAPES.map(([n, r]) => <button type="button" key={n} className={Number(p.radius) === r ? 'on' : ''} onClick={() => set({ radius: r })}>{n}</button>)}</div></Row>
        <Row label="Alignment"><Align value={p.align} onChange={(align) => set({ align })} /></Row>
        <label className="check"><input type="checkbox" checked={!!p.full} onChange={(e) => set({ full: e.target.checked })} /> Full width button</label>
      </>);
    case 'columns':
      return (<>
        <Row label="Column sizes"><select value={p.ratio} onChange={(e) => set({ ratio: e.target.value })}><option value="50-50">Half and half</option><option value="33-67">Narrow then wide</option><option value="67-33">Wide then narrow</option></select></Row>
        <Row label="Space between"><Slider value={p.gap} min={0} max={48} onChange={(gap) => set({ gap })} /></Row>
        <p className="muted">Drag blocks into either column. On phones the columns stack.</p>
      </>);
    case 'divider':
      return (<>
        <Row label="Color"><Color value={p.color} onChange={(color) => set({ color })} /></Row>
        <Row label="Thickness"><Slider value={p.thickness} min={1} max={6} onChange={(thickness) => set({ thickness })} /></Row>
      </>);
    case 'spacer':
      return <Row label="Height"><Slider value={p.height} min={4} max={120} onChange={(height) => set({ height })} /></Row>;
    case 'social':
      return (<>
        {p.items.map((it, i) => (
          <div className="stepbox" key={i} style={{ margin: '0 0 8px' }}>
            <div className="row"><input value={it.label} placeholder="Name" onChange={(e) => set({ items: p.items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <button type="button" className="btn danger sm" onClick={() => set({ items: p.items.filter((_, j) => j !== i) })}>Remove</button></div>
            <input style={{ marginTop: 6 }} value={it.url} placeholder="https://" onChange={(e) => set({ items: p.items.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
          </div>
        ))}
        {p.items.length < 8 && <button type="button" className="btn ghost sm" onClick={() => set({ items: [...p.items, { label: 'Website', url: '' }] })}>Add a link</button>}
        <Row label="Alignment"><Align value={p.align} onChange={(align) => set({ align })} /></Row>
        <p className="muted">Links without an address are left out of the email.</p>
      </>);
    case 'html':
      return <Row label="Your HTML"><textarea rows="10" value={p.html} onChange={(e) => set({ html: e.target.value })} /><div className="muted">Advanced. Write email-safe HTML with inline styles.</div></Row>;
    default:
      return <p className="muted">Every email needs a footer with your postal address and an unsubscribe link. Wynmail fills it in for you, so this block cannot be moved or removed.</p>;
  }
}

export default function Inspector({ block, settings, setSettings, set, onDuplicate, onDelete, onDeselect }) {
  if (!block) {
    return (
      <>
        <h4>Email style</h4>
        <p className="muted" style={{ marginTop: 0 }}>Click a block to edit it, or change how the whole email looks.</p>
        <Row label="Background around the email"><Color value={settings.background} onChange={(background) => setSettings({ background })} /></Row>
        <Row label="Email background"><Color value={settings.contentBg} onChange={(contentBg) => setSettings({ contentBg })} /></Row>
        <Row label="Email width"><Slider value={settings.width} min={480} max={680} onChange={(width) => setSettings({ width })} /></Row>
        <Row label="Font"><select value={settings.font} onChange={(e) => setSettings({ font: e.target.value })}>{Object.entries(FONT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Row>
        <Row label="Text size"><Slider value={settings.fontSize} min={12} max={22} onChange={(fontSize) => setSettings({ fontSize })} /></Row>
        <Row label="Text color"><Color value={settings.textColor} onChange={(textColor) => setSettings({ textColor })} /></Row>
        <Row label="Link color"><Color value={settings.linkColor} onChange={(linkColor) => setSettings({ linkColor })} /></Row>
      </>
    );
  }
  const locked = block.type === 'footer';
  return (
    <>
      <div className="between" style={{ marginBottom: 10 }}>
        <h4 style={{ margin: 0 }}>{BLOCK_LABELS[block.type]}</h4>
        <div className="row">
          {!locked && <button type="button" className="btn ghost sm" onClick={onDuplicate}>Duplicate</button>}
          {!locked && <button type="button" className="btn danger sm" onClick={onDelete}>Delete</button>}
          <button type="button" className="btn ghost sm" onClick={onDeselect}>Done</button>
        </div>
      </div>
      <Fields block={block} set={set} />
      {!locked && block.type !== 'spacer' && (
        <details className="spacing">
          <summary>Spacing and background</summary>
          <Row label="Space above and below"><Slider value={block.props.padY ?? 12} min={0} max={60} onChange={(padY) => set({ padY })} /></Row>
          <Row label="Space left and right"><Slider value={block.props.padX ?? 24} min={0} max={60} onChange={(padX) => set({ padX })} /></Row>
          <Row label="Background color"><Color value={block.props.bg} none onChange={(bg) => set({ bg })} /></Row>
        </details>
      )}
    </>
  );
}
