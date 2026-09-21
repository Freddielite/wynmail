import { useMemo } from 'react';
import { PRESETS } from './presets.js';
import { previewDocument, renderDesign } from './render.js';

function Thumb({ html }) {
  return (
    <div className="gthumb">
      <iframe title="Template preview" sandbox="" tabIndex={-1} srcDoc={previewDocument(html)} />
    </div>
  );
}

// Starting point for a visual email: built-in designs plus the workspace's own saved designs.
export default function Gallery({ saved = [], onPick, note }) {
  const presets = useMemo(() => PRESETS.map((p) => { const design = p.make(); return { ...p, design, html: renderDesign(design) }; }), []);
  return (
    <div className="gallery">
      {note && <p className="muted" style={{ marginTop: 0 }}>{note}</p>}
      <h4>Start from a design</h4>
      <div className="ggrid">
        {presets.map((p) => (
          <button type="button" className="gcard" key={p.key} data-preset={p.key} onClick={() => onPick(p.make())}>
            <Thumb html={p.html} />
            <strong>{p.name}</strong>
            <span className="muted">{p.description}</span>
          </button>
        ))}
      </div>
      {saved.length > 0 && (
        <>
          <h4 style={{ marginTop: 20 }}>Your saved templates</h4>
          <div className="ggrid">
            {saved.map((t) => (
              <button type="button" className="gcard" key={t.id} onClick={() => onPick(t)}>
                <Thumb html={t.html} />
                <strong>{t.name}</strong>
                <span className="muted">{t.design ? 'Visual design' : 'HTML template'}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
