// Pure tests for the visual builder's renderer, block tree and presets. No server needed.
import { renderDesign, renderBlockPreview, defaultBlock, defaultDesign, formatText, safeUrl, safeImage, sampleMerge } from '../../web/src/builder/render.js';
import { insert, remove, move, duplicate, update, getAt, nudge, ensureFooter } from '../../web/src/builder/tree.js';
import { PRESETS } from '../../web/src/builder/presets.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const mk = (type, props = {}) => { const b = defaultBlock(type); b.props = { ...b.props, ...props }; return b; };
const design = (blocks, settings = {}) => { const d = defaultDesign(); d.settings = { ...d.settings, ...settings }; d.blocks = [...blocks, d.blocks[0]]; return d; };
const types = (blocks) => blocks.map((b) => b.type).join(',');

// renderer
const html = renderDesign(design([mk('heading', { text: 'Hi {{first_name|friend}}' }), mk('text', { text: 'One **bold** and *italic* [link](https://a.com/x?y=1&z=2)\n\nSecond paragraph' }), mk('button', { label: 'Go', url: 'https://go.com' })]));
check('output is table based with inline styles and no scripts', html.includes('<table') && html.includes('style="') && !/<script/i.test(html));
check('merge fields are left for the sender to fill in', html.includes('{{first_name|friend}}'));
check('the footer token is always present', html.includes('{{footer}}') && html.indexOf('{{footer}}') > html.indexOf('Go'));
check('text formatting works', html.includes('<strong>bold</strong>') && html.includes('<em>italic</em>') && html.includes('href="https://a.com/x?y=1&amp;z=2"') && html.split('<p style').length - 1 >= 2);
check('images without an address are left out of the email', !renderDesign(design([mk('image')])).includes('<img'));
check('an empty image shows a placeholder while editing', renderBlockPreview(mk('image'), design([])).includes('Image:'));

const evil = renderDesign(design([
  mk('heading', { text: '<img src=x onerror=alert(1)>', color: 'red;background:url(javascript:1)' }),
  mk('text', { text: '<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://ok.com)', color: '#12345' }),
  mk('image', { src: 'javascript:alert(1)', alt: '"><script>' }),
  mk('image', { src: 'https://ok.com/a.png', alt: '"><script>x</script>', link: 'javascript:alert(1)', radius: '9999' }),
  mk('button', { label: '<b>x</b>', url: 'javascript:alert(1)', buttonBg: 'url(x)', radius: 'abc' }),
  mk('social', { items: [{ label: '<i>x</i>', url: 'javascript:1' }, { label: 'Ok', url: 'https://ok.com' }] })
], { background: 'expression(1)', font: 'evil', width: 99999 }));
check('markup in text is escaped', !evil.includes('<img src=x') && !evil.includes('<script>alert') && evil.includes('&lt;script&gt;'));
check('unsafe links are dropped, safe ones kept', !/href="javascript/i.test(evil) && evil.includes('href="https://ok.com"'));
check('unsafe colors and fonts fall back to defaults', !evil.includes('expression(') && !evil.includes('url(x)') && !evil.includes('red;background') && evil.includes('Arial'));
check('unsafe image addresses are refused and alt text is escaped', !evil.includes('src="javascript') && evil.includes('alt="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"'));
check('sizes are clamped', evil.includes('max-width:700px') && evil.includes('border-radius:40px'));
check('a bare https:// is not a link', safeUrl('https://') === '' && safeUrl('https:// ') === '');
check('safe URL helper accepts merge fields and mail links', safeUrl('{{unsubscribe_url}}') === '{{unsubscribe_url}}' && safeUrl('mailto:a@b.com') === 'mailto:a@b.com' && safeUrl('ftp://x') === '' && safeImage('data:image/png;base64,AA') === '');

// columns
const cols = mk('columns'); cols.props.cols = [[mk('text', { text: 'Left side' })], [mk('button', { label: 'Right button' })]]; cols.props.ratio = '33-67';
const colHtml = renderDesign(design([cols]));
check('columns render two cells with the chosen ratio and stack on phones', colHtml.includes('width="33%"') && colHtml.includes('width="67%"') && colHtml.includes('Left side') && colHtml.includes('Right button') && colHtml.includes('.wm-col{display:block'));
const nested = mk('columns'); nested.props.cols = [[mk('columns')], []];
check('columns inside columns are ignored', !renderDesign(design([nested])).match(/<table[^>]*>[\s\S]*<table[^>]*width="100%"[\s\S]*<table[^>]*width="100%"[\s\S]*<table[^>]*width="50%/));

// custom html and footers
check('custom HTML is included as written', renderDesign(design([mk('html', { html: '<p class="mine">Mine</p>' })])).includes('<p class="mine">Mine</p>'));
check('the editor never injects raw HTML blocks', !renderBlockPreview(mk('html', { html: '<script>alert(1)</script>' }), design([])).includes('<script>'));
check('sample merge fills names and the footer for previews', sampleMerge('Hi {{first_name|x}} {{company|Acme}} {{footer}}').includes('Hi Ada Acme') && sampleMerge('{{footer}}').includes('Unsubscribe'));

// tree
let blocks = design([mk('heading'), mk('text'), mk('button')]).blocks;
check('the footer is always last', types(blocks) === 'heading,text,button,footer');
let r = insert(blocks, [1], mk('divider'));
check('insert puts a block at the position', types(r.blocks) === 'heading,divider,text,button,footer' && r.path[0] === 1);
r = insert(blocks, [99], mk('spacer'));
check('inserting past the end still lands above the footer', types(r.blocks) === 'heading,text,button,spacer,footer');
check('the footer cannot be inserted, removed or moved', insert(blocks, [0], mk('footer')).path === null && remove(blocks, [3]) === blocks && move(blocks, [3], [0]) === blocks);
check('remove deletes a block', types(remove(blocks, [1])) === 'heading,button,footer');
check('move reorders and accounts for the shifted position', types(move(blocks, [0], [3])) === 'text,button,heading,footer' && types(move(blocks, [2], [0])) === 'button,heading,text,footer');
check('nudge moves one step but never past the footer', types(nudge(blocks, [1], 1).blocks) === 'heading,button,text,footer' && nudge(blocks, [2], 1) === null && nudge(blocks, [0], -1) === null);
check('duplicate makes an independent copy with a new id', (() => { const d = duplicate(blocks, [1]); return types(d.blocks) === 'heading,text,text,button,footer' && d.blocks[1].id !== d.blocks[2].id && d.path[0] === 2; })());
check('update changes props without touching the original', (() => { const u = update(blocks, [0], { text: 'Changed' }); return u[0].props.text === 'Changed' && blocks[0].props.text === 'Your headline'; })());

// columns in the tree
const withCols = design([mk('heading'), mk('columns')]).blocks;
let c = insert(withCols, [1, 0, 0], mk('text'));
check('blocks can be dropped into a column', c.path && getAt(c.blocks, [1, 0, 0]).type === 'text');
check('columns cannot be dropped into a column', insert(withCols, [1, 0, 0], mk('columns')).path === null && move(withCols, [1], [1, 0, 0]) === withCols);
c = insert(c.blocks, [1, 0, 1], mk('button'));
check('order inside a column is kept', getAt(c.blocks, [1, 0, 0]).type === 'text' && getAt(c.blocks, [1, 0, 1]).type === 'button');
const moved = move(c.blocks, [1, 0, 0], [1, 1, 0]);
check('a block moves between columns', getAt(moved, [1, 1, 0]).type === 'text' && getAt(moved, [1, 0, 0]).type === 'button');
const out = move(moved, [1, 1, 0], [0]);
check('a block moves out of a column to the top level', types(out) === 'text,heading,columns,footer');
const inn = move(design([mk('text'), mk('columns')]).blocks, [0], [0, 0, 0]);
check('bad drop targets change nothing', inn.length === 3);
check('ensureFooter repairs a design that lost its footer', types(ensureFooter([mk('text')])) === 'text,footer');

// presets
check('every preset builds and renders a safe email with a footer', PRESETS.length >= 6 && PRESETS.every((p) => { const d = p.make(); const h = renderDesign(d); return d.blocks.at(-1).type === 'footer' && h.includes('{{footer}}') && !/<script/i.test(h) && h.length < 60000; }));
check('presets have fresh ids each time', PRESETS[1].make().blocks[0].id !== PRESETS[1].make().blocks[0].id);
check('designs stay small', JSON.stringify(PRESETS.find((p) => p.key === 'newsletter').make()).length < 20000);
check('formatText keeps single newlines as line breaks', formatText('a\nb').includes('a<br>b'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
