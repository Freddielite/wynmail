import { useState } from 'react';
import EmailBuilder from './EmailBuilder.jsx';
import Gallery from './Gallery.jsx';
import { previewDocument, renderDesign } from './render.js';

// The content editor used by templates, campaigns and automation emails.
// value is { design, html }. The visual builder writes both. Typing HTML directly drops the design.
export default function EditorField({ value, onChange, templates = [] }) {
  const html = value.html || '';
  const [mode, setMode] = useState(value.design ? 'visual' : html.trim() ? 'html' : 'visual');
  const [builderKey, setBuilderKey] = useState(0);

  const pick = (item) => {
    if (html.trim() && !value.design && !window.confirm('Starting a design replaces the HTML you have written. Continue?')) return;
    if (item.design || item.blocks) {
      const design = item.blocks ? item : item.design;
      onChange({ design, html: item.blocks ? renderDesign(item) : item.html });
      setBuilderKey((k) => k + 1); setMode('visual');
    } else {
      onChange({ design: null, html: item.html }); setMode('html');
    }
  };

  return (
    <div className="editorfield">
      <div className="tabs">
        <button type="button" className={mode === 'visual' ? 'on' : ''} onClick={() => setMode('visual')}>Visual</button>
        <button type="button" className={mode === 'html' ? 'on' : ''} onClick={() => setMode('html')}>HTML</button>
      </div>

      {mode === 'visual' && (value.design
        ? <EmailBuilder key={builderKey} design={value.design} onChange={onChange} />
        : <Gallery saved={templates} onPick={pick} note={html.trim() ? 'This email is written in HTML. Starting a design replaces it.' : ''} />)}

      {mode === 'html' && (
        <div className="grid cols-2">
          <div>
            {value.design && <p className="muted" style={{ marginTop: 0 }}>Editing the HTML here disconnects the visual design. Use the Visual tab to keep using blocks.</p>}
            <textarea rows="16" value={html} placeholder="<p>Write your email HTML here</p>" onChange={(e) => onChange({ design: null, html: e.target.value })} />
          </div>
          <iframe title="HTML preview" sandbox="" className="preview" srcDoc={previewDocument(html)} />
        </div>
      )}
    </div>
  );
}
