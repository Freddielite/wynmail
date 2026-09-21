// Visual designs stored with templates, campaigns and automation emails, and the inline footer.
// Fresh database, FORCE_PROVIDER=console.
import { renderDesign, defaultBlock, defaultDesign } from '../../web/src/builder/render.js';
import { PRESETS } from '../../web/src/builder/presets.js';

const BASE = process.env.BASE || 'http://localhost:4000';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
await call('PUT', '/api/workspaces/1', { token: A, body: { sending_domain: 'wyntek.ng', from_email: 'news@wyntek.ng', footer_address: 'Abuja, Nigeria' } });
const list = (await call('POST', '/api/workspaces/1/lists', { token: A, body: { name: 'L' } })).data;
await call('POST', '/api/workspaces/1/contacts', { token: A, body: { email: 'ada@example.com', first_name: 'Ada', list_id: list.id } });

const design = PRESETS.find((p) => p.key === 'welcome').make();
design.blocks.find((b) => b.type === 'button').props.url = 'https://wyntek.ng/start';
const html = renderDesign(design);

// templates
const t = (await call('POST', '/api/workspaces/1/templates', { token: A, body: { name: 'Welcome', subject: 'Hi', html, design } })).data;
const got = (await call('GET', '/api/workspaces/1/templates', { token: A })).data.find((x) => x.id === t.id);
check('a template keeps its visual design as data', got.design?.blocks?.length === design.blocks.length && got.design.blocks[0].type === 'heading' && got.html === html);
await call('PUT', `/api/workspaces/1/templates/${t.id}`, { token: A, body: { name: 'Renamed' } });
check('editing other fields keeps the design', (await call('GET', '/api/workspaces/1/templates', { token: A })).data.find((x) => x.id === t.id).design?.blocks?.length === design.blocks.length);
const edited = structuredClone(design); edited.blocks[0].props.text = 'Edited headline';
await call('PUT', `/api/workspaces/1/templates/${t.id}`, { token: A, body: { design: edited, html: renderDesign(edited) } });
check('a new design replaces the old one', (await call('GET', '/api/workspaces/1/templates', { token: A })).data.find((x) => x.id === t.id).design.blocks[0].props.text === 'Edited headline');
await call('PUT', `/api/workspaces/1/templates/${t.id}`, { token: A, body: { design: null, html: '<p>Plain</p>' } });
check('design can be cleared when someone switches to plain HTML', (await call('GET', '/api/workspaces/1/templates', { token: A })).data.find((x) => x.id === t.id).design === null);
check('an invalid design is refused', (await call('POST', '/api/workspaces/1/templates', { token: A, body: { name: 'x', html: 'x', design: 'nope' } })).status === 400 && (await call('POST', '/api/workspaces/1/templates', { token: A, body: { name: 'x', html: 'x', design: [1] } })).status === 400);
check('an oversized design is refused', (await call('POST', '/api/workspaces/1/templates', { token: A, body: { name: 'x', html: 'x', design: { blocks: 'x'.repeat(310000) } } })).status === 400);

// campaigns: the footer lands inside the design, once
const camp = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { name: 'Designed', subject: 'Hello', html, design, list_id: list.id } })).data;
check('a campaign stores its design', (await call('GET', '/api/workspaces/1/campaigns', { token: A })).data.find((c) => c.id === camp.id).design.blocks.length === design.blocks.length);
const prev = (await call('GET', `/api/workspaces/1/campaigns/${camp.id}/preview`, { token: A })).data.html;
check('the unsubscribe footer appears exactly once', (prev.match(/Unsubscribe<\/a>/g) || []).length === 1 && !prev.includes('{{footer}}'), (prev.match(/Unsubscribe<\/a>/g) || []).length);
check('the footer sits inside the designed email, before the end of its table', prev.indexOf('Unsubscribe</a>') < prev.lastIndexOf('</table>') && prev.includes('Abuja, Nigeria'));
check('links in designed emails are tracked', /href="http:\/\/localhost:4000\/t\/c\/preview\?url=/.test(prev));
const plain = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { subject: 'Plain', html: '<p>Hello</p>', list_id: list.id } })).data;
const plainPrev = (await call('GET', `/api/workspaces/1/campaigns/${plain.id}/preview`, { token: A })).data.html;
check('plain HTML campaigns still get the footer at the end, once', (plainPrev.match(/Unsubscribe<\/a>/g) || []).length === 1 && plainPrev.indexOf('Hello') < plainPrev.indexOf('Unsubscribe'));
const twice = (await call('POST', '/api/workspaces/1/campaigns', { token: A, body: { subject: 'Twice', html: '<p>a</p>{{footer}}<p>b</p>{{ footer }}', list_id: list.id } })).data;
const twicePrev = (await call('GET', `/api/workspaces/1/campaigns/${twice.id}/preview`, { token: A })).data.html;
check('a repeated footer token only places one footer', (twicePrev.match(/Unsubscribe<\/a>/g) || []).length === 1 && twicePrev.indexOf('<p>a</p>') < twicePrev.indexOf('Unsubscribe') && twicePrev.indexOf('Unsubscribe') < twicePrev.indexOf('<p>b</p>'));
const dup = (await call('POST', `/api/workspaces/1/campaigns/${camp.id}/duplicate`, { token: A })).data;
check('duplicating keeps the design', dup.design?.blocks?.length === design.blocks.length && dup.id !== camp.id);
await call('PUT', `/api/workspaces/1/campaigns/${camp.id}`, { token: A, body: { subject: 'Changed' } });
check('saving a campaign without a design keeps the existing one', (await call('GET', '/api/workspaces/1/campaigns', { token: A })).data.find((c) => c.id === camp.id).design?.blocks?.length === design.blocks.length);

// merge fallbacks still work inside designed emails, with names escaped
await call('POST', '/api/workspaces/1/contacts', { token: A, body: { email: 'noname@example.com', list_id: list.id } });
const noname = (await call('GET', '/api/workspaces/1/contacts', { token: A })).data.find((c) => c.email === 'noname@example.com');
const fbPrev = (await call('GET', `/api/workspaces/1/campaigns/${camp.id}/preview?contact_id=${noname.id}`, { token: A })).data.html;
check('name fallbacks work inside designed emails', fbPrev.includes('Welcome, friend!'));

// sending
check('a designed email can be sent as a test', (await call('POST', '/api/workspaces/1/test-email', { token: A, body: { subject: 'Designed test', html } })).status === 200);
await call('POST', `/api/workspaces/1/campaigns/${camp.id}/send`, { token: A });
await new Promise((r) => setTimeout(r, 5000));
check('a designed campaign is delivered', (await call('GET', `/api/workspaces/1/campaigns/${camp.id}/messages`, { token: A })).data.some((m) => m.status === 'sent'));

// automations
const step = { delay_minutes: 0, subject: 'Welcome', html, design, preview_text: 'p' };
const auto = (await call('POST', '/api/workspaces/1/automations', { token: A, body: { name: 'A', list_id: list.id, active: false, steps: [step] } })).data;
check('automation emails keep their design', (await call('GET', `/api/workspaces/1/automations/${auto.id}`, { token: A })).data.steps[0].design?.blocks?.length === design.blocks.length);
await call('PUT', `/api/workspaces/1/automations/${auto.id}`, { token: A, body: { name: 'A', list_id: list.id, active: false, steps: [{ ...step, design: null, html: '<p>Plain now</p>' }] } });
check('and the design clears when the email becomes plain HTML', (await call('GET', `/api/workspaces/1/automations/${auto.id}`, { token: A })).data.steps[0].design === null);
check('a bad design in an automation email is refused', (await call('POST', '/api/workspaces/1/automations', { token: A, body: { name: 'B', list_id: list.id, active: false, steps: [{ ...step, design: 'nope' }] } })).status === 400);

// isolation
const made = await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'owner@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } });
const O = (await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'acme-pass-99' } })).data.token;
check('another workspace sees none of these designs', (await call('GET', `/api/workspaces/${made.data.id}/templates`, { token: O })).data.length === 0 && (await call('GET', `/api/workspaces/${made.data.id}/campaigns`, { token: O })).data.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
