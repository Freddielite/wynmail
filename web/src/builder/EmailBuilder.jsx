import { createContext, Fragment, useContext, useRef, useState } from 'react';
import { BLOCK_TYPES, BLOCK_LABELS, RATIOS, defaultBlock, paddingOf, renderBlockPreview, renderDesign, settingsOf, FONTS, previewDocument } from './render.js';
import { insert, remove, move, duplicate, update, getAt, nudge, samePath, ensureFooter } from './tree.js';
import Inspector from './Inspector.jsx';

const Ctx = createContext(null);

function Gap({ path, empty }) {
  const c = useContext(Ctx);
  const key = path.join('.');
  return (
    <div className={`dropgap${c.over === key ? ' over' : ''}${empty ? ' empty' : ''}`}
      onDragOver={(e) => { if (!c.drag) return; e.preventDefault(); e.stopPropagation(); if (c.over !== key) c.setOver(key); }}
      onDragLeave={() => { if (c.over === key) c.setOver(''); }}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation();
        const raw = e.dataTransfer.getData('text/wm');
        c.setOver(''); c.setDrag(null);
        if (raw) c.drop(JSON.parse(raw), path);
      }}>
      {empty ? 'Drop blocks here' : null}
    </div>
  );
}

function BlockList({ blocks, parent }) {
  return (
    <>
      {blocks.map((b, j) => {
        const path = parent ? [...parent, j] : [j];
        return <Fragment key={b.id}><Gap path={path} /><BlockView block={b} path={path} /></Fragment>;
      })}
      {parent && <Gap path={[...parent, blocks.length]} empty={blocks.length === 0} />}
    </>
  );
}

// Dropping on the top half of a block puts the new one before it, the bottom half puts it after.
function dropPath(e, path, locked) {
  const r = e.currentTarget.getBoundingClientRect();
  const after = !locked && e.clientY > r.top + r.height / 2;
  const p = [...path];
  if (after) p[p.length - 1] += 1;
  return p;
}

function BlockView({ block, path }) {
  const c = useContext(Ctx);
  const selected = samePath(c.sel, path);
  const locked = block.type === 'footer';
  const bg = /^#[0-9a-f]{3,8}$/i.test(block.props.bg || '') ? block.props.bg : undefined;
  return (
    <div className={`bblock${selected ? ' sel' : ''}${locked ? ' locked' : ''}`} data-type={block.type} draggable={!locked}
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/wm', JSON.stringify({ kind: 'move', path })); c.setDrag({ kind: 'move' }); }}
      onDragEnd={() => { c.setDrag(null); c.setOver(''); }}
      onDragOver={(e) => { if (!c.drag) return; e.preventDefault(); e.stopPropagation(); const k = dropPath(e, path, locked).join('.'); if (c.over !== k) c.setOver(k); }}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation();
        const raw = e.dataTransfer.getData('text/wm');
        const target = dropPath(e, path, locked);
        c.setOver(''); c.setDrag(null);
        if (raw) c.drop(JSON.parse(raw), target);
      }}
      onClick={(e) => { e.stopPropagation(); c.setSel(path); }}>
      {selected && !locked && (
        <div className="btools" onClick={(e) => e.stopPropagation()}>
          <button type="button" title="Move up" onClick={() => c.nudge(path, -1)}>Up</button>
          <button type="button" title="Move down" onClick={() => c.nudge(path, 1)}>Down</button>
          <button type="button" title="Duplicate" onClick={() => c.duplicate(path)}>Copy</button>
          <button type="button" title="Delete" onClick={() => c.remove(path)}>Delete</button>
        </div>
      )}
      {block.type === 'columns' ? (
        <div style={{ padding: paddingOf(block), background: bg }}>
          <div className="bcols" style={{ gridTemplateColumns: `${(RATIOS[block.props.ratio] || [50, 50]).map((n) => `${n}fr`).join(' ')}`, gap: `${Number(block.props.gap) || 16}px` }}>
            {[0, 1].map((ci) => <div className="bcol" key={ci}><BlockList blocks={block.props.cols[ci] || []} parent={[path[0], ci]} /></div>)}
          </div>
        </div>
      ) : (
        <div className="binner" dangerouslySetInnerHTML={{ __html: renderBlockPreview(block, c.design) }} />
      )}
    </div>
  );
}

const findPath = (blocks, id) => {
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].id === id) return [i];
    const cols = blocks[i].props?.cols;
    if (cols) for (let ci = 0; ci < cols.length; ci += 1) { const j = cols[ci].findIndex((b) => b.id === id); if (j >= 0) return [i, ci, j]; }
  }
  return null;
};

export default function EmailBuilder({ design: initial, onChange }) {
  const [design, setDesign] = useState(() => ({ ...initial, blocks: ensureFooter(initial.blocks || []) }));
  const [sel, setSel] = useState(null);
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState('');
  const [view, setView] = useState('edit');
  const last = useRef({ key: '', at: 0 });
  const st = settingsOf(design);

  const emit = (d) => onChange({ design: d, html: renderDesign(d) });
  // Typing in a panel is merged into one undo step so undo is useful.
  const commit = (next, nextSel, coalesceKey = '') => {
    const now = Date.now();
    const merge = coalesceKey && last.current.key === coalesceKey && now - last.current.at < 1200;
    last.current = { key: coalesceKey, at: now };
    if (!merge) setPast((p) => [...p.slice(-59), design]);
    setFuture([]);
    setDesign(next);
    if (nextSel !== undefined) setSel(nextSel);
    emit(next);
  };
  const undo = () => { if (!past.length) return; const prev = past[past.length - 1]; setPast(past.slice(0, -1)); setFuture([design, ...future]); setDesign(prev); setSel(null); last.current = { key: '', at: 0 }; emit(prev); };
  const redo = () => { if (!future.length) return; const [nxt, ...rest] = future; setFuture(rest); setPast([...past, design]); setDesign(nxt); setSel(null); last.current = { key: '', at: 0 }; emit(nxt); };

  const withBlocks = (blocks, s, key) => commit({ ...design, blocks }, s, key);
  const addBlock = (type, path) => {
    const r = insert(design.blocks, path, defaultBlock(type));
    if (r.path) withBlocks(r.blocks, r.path);
  };
  const addAfterSelection = (type) => {
    let path = [design.blocks.length - 1];
    if (sel) { path = type === 'columns' ? [sel[0] + 1] : [...sel]; if (type !== 'columns') path[path.length - 1] += 1; }
    addBlock(type, path);
  };
  const drop = (payload, path) => {
    if (payload.kind === 'new') return addBlock(payload.type, path);
    const moving = getAt(design.blocks, payload.path);
    const next = move(design.blocks, payload.path, path);
    if (next !== design.blocks && moving) withBlocks(next, findPath(next, moving.id));
  };
  const ops = {
    design, sel, setSel, drag, setDrag, over, setOver, drop,
    nudge: (path, d) => { const r = nudge(design.blocks, path, d); if (r) withBlocks(r.blocks, r.path); },
    duplicate: (path) => { const r = duplicate(design.blocks, path); if (r.path) withBlocks(r.blocks, r.path); },
    remove: (path) => { withBlocks(remove(design.blocks, path), null); }
  };

  const block = sel ? getAt(design.blocks, sel) : null;
  const onKey = (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel && block && block.type !== 'footer') { e.preventDefault(); ops.remove(sel); }
    else if (e.key === 'Escape') setSel(null);
  };

  return (
    <Ctx.Provider value={ops}>
      <div className="builder" tabIndex={-1} onKeyDown={onKey}>
        <div className="bbar">
          <div className="row">
            <button type="button" className="btn ghost sm" disabled={!past.length} onClick={undo}>Undo</button>
            <button type="button" className="btn ghost sm" disabled={!future.length} onClick={redo}>Redo</button>
          </div>
          <div className="tabs" style={{ margin: 0 }}>
            {[['edit', 'Edit'], ['desktop', 'Preview'], ['phone', 'Phone']].map(([k, l]) => <button type="button" key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}
          </div>
        </div>

        {view !== 'edit' ? (
          <div className="bpreview">
            <iframe title="Email preview" sandbox="" srcDoc={previewDocument(renderDesign(design))} style={{ width: view === 'phone' ? 375 : '100%', maxWidth: '100%' }} />
          </div>
        ) : (
          <div className="bgrid">
            <aside className="bpalette">
              <h4>Blocks</h4>
              <p className="muted">Drag onto the email, or click to add.</p>
              <div className="bchips">
                {BLOCK_TYPES.map((t) => (
                  <button type="button" key={t} className="bchip" draggable data-add={t}
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/wm', JSON.stringify({ kind: 'new', type: t })); setDrag({ kind: 'new' }); }}
                    onDragEnd={() => { setDrag(null); setOver(''); }}
                    onClick={() => addAfterSelection(t)}>{BLOCK_LABELS[t]}</button>
                ))}
              </div>
            </aside>

            <div className={`bcanvas${drag ? ' dragging' : ''}`} style={{ background: st.background }} onClick={() => setSel(null)}>
              <div className="bpaper" style={{ maxWidth: st.width, background: st.contentBg, fontFamily: FONTS[st.font], color: st.textColor, fontSize: st.fontSize }}>
                <BlockList blocks={design.blocks} parent={null} />
              </div>
            </div>

            <aside className="binspector">
              <Inspector block={block} settings={st}
                setSettings={(patch) => commit({ ...design, settings: { ...design.settings, ...patch } }, undefined, 'settings')}
                set={(patch) => commit({ ...design, blocks: update(design.blocks, sel, patch) }, undefined, `b${sel.join('.')}`)}
                onDuplicate={() => ops.duplicate(sel)} onDelete={() => ops.remove(sel)} onDeselect={() => setSel(null)} />
            </aside>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
