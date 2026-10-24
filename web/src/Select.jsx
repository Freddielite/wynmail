import { Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// A drop-in replacement for the browser's <select>. Same <option> children, same onChange(e) with e.target.value,
// but styled to match the app, searchable when the list is long, and usable with keyboard, mouse and touch.

const text = (node) => Children.toArray(node).map((n) => (isValidElement(n) ? text(n.props.children) : String(n))).join('');

function collect(children, out = []) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) collect(child.props.children, out);
    else if (child.type === 'option') {
      const label = text(child.props.children);
      out.push({ value: String(child.props.value ?? label), label, disabled: !!child.props.disabled });
    } else if (child.type === 'optgroup') collect(child.props.children, out);
  });
  return out;
}

const SEARCH_AFTER = 10;

export default function Select({ value, onChange, children, disabled = false, className = '', style, id, name, 'aria-label': ariaLabel, placeholder, ...rest }) {
  const options = useMemo(() => collect(children), [children]);
  const current = String(value ?? '');
  const selected = options.find((o) => o.value === current);
  const uid = useId();
  const btn = useRef(null);
  const menu = useRef(null);
  const typed = useRef({ text: '', at: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const searchable = options.length > SEARCH_AFTER;

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom, above = r.top;
    const flip = below < 260 && above > below;
    const room = Math.max(120, (flip ? above : below) - 12);
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 200) - 8)), width: r.width, maxHeight: Math.min(320, room),
      ...(flip ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
  }, []);

  const openMenu = () => {
    if (disabled) return;
    place();
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
    setOpen(true);
  };
  const close = (focus = true) => { setOpen(false); if (focus) btn.current?.focus(); };

  const choose = (opt) => {
    if (!opt || opt.disabled) return;
    close();
    if (opt.value !== current) onChange?.({ target: { value: opt.value, name }, currentTarget: { value: opt.value, name } });
  };

  // Keep the menu attached to the button while the page scrolls or resizes, and close it on an outside click.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const onMove = () => place();
    const onDown = (e) => { if (!menu.current?.contains(e.target) && !btn.current?.contains(e.target)) close(false); };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);
  useEffect(() => { if (disabled && open) setOpen(false); }, [disabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open && searchable) menu.current?.querySelector('input')?.focus({ preventScroll: true }); }, [open, searchable]);
  useEffect(() => { if (open) setActive(visible.length ? 0 : -1); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (dir) => {
    if (!visible.length) return;
    let i = active;
    for (let n = 0; n < visible.length; n++) { i = (i + dir + visible.length) % visible.length; if (!visible[i].disabled) break; }
    setActive(i);
  };

  const onKey = (e) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openMenu(); return; }
      // Typing on a closed select jumps to a matching option, like the native one.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const t = typed.current, now = Date.now();
        t.text = now - t.at > 700 ? e.key.toLowerCase() : t.text + e.key.toLowerCase(); t.at = now;
        const hit = options.find((o) => !o.disabled && o.label.toLowerCase().startsWith(t.text));
        if (hit) { e.preventDefault(); choose(hit); }
      }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close(false);
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(visible.length - 1); }
    else if (e.key === 'Enter' || (e.key === ' ' && !searchable)) { e.preventDefault(); choose(visible[active]); }
    else if (!searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      const t = typed.current, now = Date.now();
      t.text = now - t.at > 700 ? e.key.toLowerCase() : t.text + e.key.toLowerCase(); t.at = now;
      const i = visible.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(t.text));
      if (i >= 0) setActive(i);
    }
  };

  const label = selected ? selected.label : (placeholder || options[0]?.label || '');
  const muted = !selected || current === '';

  return (
    <div className={`sel${style?.width === 'auto' ? ' sel-auto' : ''} ${className}`} style={style} onKeyDown={onKey}>
      <button
        type="button" ref={btn} id={id} name={name} disabled={disabled} className={`sel-btn${open ? ' open' : ''}${muted ? ' muted' : ''}`}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${uid}-list` : undefined} aria-label={ariaLabel}
        onClick={() => (open ? close(false) : openMenu())} {...rest}
      >
        <span className="sel-label">{label || '\u00a0'}</span>
        <svg className="sel-chev" width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 7.5 10 12l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>

      {open && pos && createPortal(
        <div ref={menu} className="sel-menu" style={pos} onKeyDown={onKey}>
          {searchable && (
            <div className="sel-search">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search options" autoComplete="off" />
            </div>
          )}
          <div id={`${uid}-list`} role="listbox" className="sel-list" aria-label={ariaLabel} style={{ maxHeight: pos.maxHeight - (searchable ? 54 : 0) }}>
            {visible.map((o, i) => (
              <div
                key={o.value + i} role="option" aria-selected={o.value === current} aria-disabled={o.disabled || undefined}
                data-active={i === active} className={`sel-opt${o.value === current ? ' on' : ''}${o.disabled ? ' off' : ''}`}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)}
              >
                <span>{o.label || '\u00a0'}</span>
                {o.value === current && <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </div>
            ))}
            {!visible.length && <div className="sel-empty">Nothing matches</div>}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
