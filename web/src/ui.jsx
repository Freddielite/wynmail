import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/* ---------- toasts ---------- */
const ToastCtx = createContext(null);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((type, text) => {
    const id = Math.random().toString(36).slice(2);
    setItems((list) => [...list.slice(-3), { id, type, text }]);
    setTimeout(() => setItems((list) => list.filter((x) => x.id !== id)), type === 'error' ? 7000 : 4000);
  }, []);
  const value = useMemo(() => ({
    success: (t) => push('success', t), error: (t) => push('error', t), info: (t) => push('info', t)
  }), [push]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.type}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// Wraps an async action: errors become toasts, and a string result becomes a success toast.
export function useGuard() {
  const toast = useToast();
  return useCallback((fn) => async (...args) => {
    try {
      const result = await fn(...args);
      if (typeof result === 'string' && result) toast.success(result);
      return result;
    } catch (err) {
      toast.error(err.message || 'Something went wrong');
    }
  }, [toast]);
}

/* ---------- button with a built-in busy state ---------- */
export function Btn({ onClick, busyText, className = 'btn', disabled, children, ...rest }) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const run = async (e) => {
    if (busy || !onClick) return;
    setBusy(true);
    try { await onClick(e); } finally { if (mounted.current) setBusy(false); }
  };

  return (
    <button className={`${className}${busy ? ' busy' : ''}`} disabled={disabled || busy} onClick={run} {...rest}>
      {busy && <span className="spinner" aria-hidden="true" />}
      {busy && busyText ? busyText : children}
    </button>
  );
}

/* ---------- polling that pauses in background tabs ---------- */
export function usePolling(fn, active, ms = 3000) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => { if (!document.hidden) ref.current(); }, ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

/* ---------- copy to clipboard ---------- */
export function CopyBtn({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text; document.body.appendChild(area); area.select();
      document.execCommand('copy'); document.body.removeChild(area);
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return <button type="button" className="btn ghost sm" onClick={copy}>{done ? 'Copied' : label}</button>;
}

export function CodeBlock({ title, text }) {
  return (
    <div className="codeblock">
      <div className="codehead"><strong>{title}</strong><CopyBtn text={text} /></div>
      <pre className="code">{text}</pre>
    </div>
  );
}

export const when = (v) => (v ? new Date(v).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');
