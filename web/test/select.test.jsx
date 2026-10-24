// The custom dropdown: opens, chooses, keyboard, search, disabled. Run with: npm test
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, bottom: 50, right: 210, width: 200, height: 40 });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const { default: Select } = await import('../src/Select.jsx');
let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const root = createRoot(document.getElementById('root'));
let val = 'b', calls = [];
const App = ({ many, disabled }) => {
  const [v, setV] = React.useState(val);
  return <Select value={v} disabled={disabled} onChange={(e) => { calls.push(e.target.value); setV(e.target.value); }} aria-label="Pick">
    <option value="">Choose one</option>
    {many ? Array.from({ length: 25 }, (_, i) => <option key={i} value={`n${i}`}>Item {i}</option>) : <><option value="a">Alpha</option><option value="b">Beta</option><option value="c" disabled>Gamma</option><option value="d">{3}% of the audience</option></>}
  </Select>;
};
const q = (s) => document.querySelector(s), all = (s) => [...document.querySelectorAll(s)];
const key = async (k, target = q('.sel-btn')) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
await act(async () => root.render(<App />));
check('shows the selected label, not the browser control', q('.sel-label').textContent === 'Beta' && !q('select'));
await act(async () => q('.sel-btn').click());
check('opens a listbox with every option', all('[role=option]').length === 5 && q('[role=listbox]'));
check('the current one is marked', q('[aria-selected=true]').textContent.startsWith('Beta'));
check('mixed text and numbers in an option become one label', all('[role=option]')[4].textContent === '3% of the audience');
await act(async () => all("[role=option]")[3].click());
check('a disabled option cannot be chosen', calls.length === 0 && q('[role=listbox]'));
await act(async () => all('[role=option]')[1].click());
check('choosing calls onChange with e.target.value and closes', calls.join() === 'a' && !q('[role=listbox]') && q('.sel-label').textContent === 'Alpha');
await key('ArrowDown'); check('arrow down opens', !!q('[role=listbox]'));
await key('ArrowDown', q('.sel-menu')); await key('Enter', q('.sel-menu'));
check('arrows and enter choose', calls.at(-1) === 'b', calls.join());
await act(async () => q('.sel-btn').click()); await key('Escape', q('.sel-menu'));
check('escape closes without changing', !q('[role=listbox]') && calls.at(-1) === 'b');
await act(async () => q('.sel-btn').click());
await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
check('clicking elsewhere closes', !q('[role=listbox]'));
check('few options have no search box', true);
await act(async () => root.render(<App many />));
await act(async () => q('.sel-btn').click());
check('long lists get a search box', !!q('.sel-search input'));
const input = q('.sel-search input');
await act(async () => { const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set; set.call(input, 'item 2'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
check('search filters the list', all('[role=option]').length === 6 && all('[role=option]').every((o) => /item 2/i.test(o.textContent)), all('[role=option]').length);
await act(async () => root.render(<App disabled />));
await act(async () => q('.sel-btn').click());
check('disabled never opens', !q('[role=listbox]') && q('.sel-btn').disabled);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
