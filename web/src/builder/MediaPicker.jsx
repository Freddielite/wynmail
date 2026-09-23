import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Btn, useGuard } from '../ui.jsx';

const fmtSize = (b) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

// A library of the workspace's pictures, with drag-and-drop or click-to-browse upload.
// onPick receives the picture's public URL.
export default function MediaPicker({ onPick, onClose }) {
  const guard = useGuard();
  const [state, setState] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef(null);

  const load = async () => setState(await api.media());
  useEffect(() => { guard(load)(); }, []);

  const upload = guard(async (file) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) throw new Error('Pictures can be PNG, JPEG, GIF or WEBP');
    const item = await api.uploadMedia(file, file.name);
    await load();
    onPick(item.url);
    return 'Uploaded';
  });

  const remove = (item) => guard(async () => {
    try {
      await api.deleteMedia(item.id);
    } catch (err) {
      if (err.status === 409 && window.confirm(`${err.message} Delete it anyway?`)) await api.deleteMedia(item.id, true);
      else throw err;
    }
    await load();
    return 'Picture deleted';
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="between"><h3 style={{ margin: 0 }}>Pictures</h3><button className="btn ghost sm" onClick={onClose}>Close</button></div>
        {state && <p className="muted" style={{ margin: '6px 0 14px' }}>{state.usage.files} of {state.usage.max_files} pictures, {fmtSize(state.usage.bytes)} used. Up to 3 MB each.</p>}

        <div className={`dropzone${dragOver ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files?.[0]); }}
          onClick={() => fileInput.current?.click()}>
          Drag a picture here, or click to choose one
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={(e) => upload(e.target.files?.[0])} />
        </div>

        <div className="mgrid">
          {(state?.items || []).map((m) => (
            <div className="mitem" key={m.id}>
              <button type="button" style={{ display: 'block', width: '100%', border: 0, background: 'none', padding: 0, cursor: 'pointer' }} onClick={() => onPick(m.url)}>
                <div className="mimg" style={{ backgroundImage: `url(${m.url})` }} />
              </button>
              <div className="mmeta">
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
                <div className="row" style={{ marginTop: 6 }}>
                  <button type="button" className="btn ghost sm" onClick={() => onPick(m.url)}>Use</button>
                  <Btn className="btn danger sm" busyText="..." onClick={remove(m)}>Delete</Btn>
                </div>
              </div>
            </div>
          ))}
        </div>
        {state && !state.items.length && <p className="muted" style={{ marginTop: 14 }}>No pictures yet. Upload one above.</p>}
      </div>
    </div>
  );
}
