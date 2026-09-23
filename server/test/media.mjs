// Picture uploads. Fresh database, FORCE_PROVIDER=console.
const BASE = process.env.BASE || 'http://localhost:4000';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const upload = async (token, bytes, type, name = 'Picture.png', ws = 1) => {
  const res = await fetch(`${BASE}/api/workspaces/${ws}/media`, { method: 'POST', headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent(name), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: bytes });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(20)]);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([26, 0, 0, 0]), Buffer.from('WEBPVP8L', 'latin1'), Buffer.alloc(20)]);

const A = (await call('POST', '/api/auth/register', { body: { email: 'admin@wyntek.ng', password: 'correct-horse-1', workspaceName: 'Wyntek' } })).data.token;
const made = await call('POST', '/api/admin/workspaces', { token: A, body: { name: 'Acme', owner_email: 'owner@acme.ng', password: 'acme-pass-99', sending_domain: 'acme.ng' } });
const O = (await call('POST', '/api/auth/login', { body: { email: 'owner@acme.ng', password: 'acme-pass-99' } })).data.token;

const up = await upload(A, PNG, 'image/png', 'My Logo.png');
check('a PNG uploads and gets a public address', up.status === 200 && /^http:\/\/localhost:4000\/m\/[a-f0-9]{24}\.png$/.test(up.data.url) && up.data.name === 'My Logo' && up.data.size === PNG.length, JSON.stringify(up));
const got = await fetch(up.data.url);
const bytes = Buffer.from(await got.arrayBuffer());
check('the address serves the exact picture', got.status === 200 && bytes.equals(PNG) && got.headers.get('content-type') === 'image/png');
check('it is served safely and cached', got.headers.get('x-content-type-options') === 'nosniff' && /immutable/.test(got.headers.get('cache-control') || '') && got.headers.get('cross-origin-resource-policy') === 'cross-origin');
check('JPEG, GIF and WEBP are accepted', (await upload(A, JPG, 'image/jpeg', 'a.jpg')).status === 200 && (await upload(A, GIF, 'image/gif', 'a.gif')).status === 200 && (await upload(A, WEBP, 'image/webp', 'a.webp')).status === 200);
check('SVG is refused', (await upload(A, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml', 'x.svg')).status === 415);
check('a label that does not match the bytes is refused', (await upload(A, Buffer.from('<html>not a picture</html>'), 'image/png', 'x.png')).status === 400 && (await upload(A, PNG, 'image/jpeg', 'x.jpg')).status === 400);
check('an empty upload is refused', (await upload(A, Buffer.alloc(0), 'image/png', 'x.png')).status === 415);
const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
const tooBig = await upload(A, big, 'image/png', 'big.png');
check('pictures over 3 MB are refused with a clear message', tooBig.status === 413 && /3 MB/.test(tooBig.data.error || ''), JSON.stringify(tooBig));
check('uploads need a sign in', (await upload(null, PNG, 'image/png')).status === 401);
check('file names are cleaned', (await upload(A, PNG, 'image/png', '<img src=x onerror=1>.png')).data.name === 'img src=x onerror=1');

const list = (await call('GET', '/api/workspaces/1/media', { token: A })).data;
check('the library lists pictures with usage', list.items.length === 5 && list.usage.files === 5 && list.usage.bytes > 0 && list.usage.max_upload === 3 * 1024 * 1024 && !JSON.stringify(list).includes('"data"'));

// public route hardening
check('unknown and malformed addresses are 404', (await fetch(`${BASE}/m/${'a'.repeat(24)}.png`)).status === 404 && (await fetch(`${BASE}/m/../../etc/passwd`)).status === 404 && (await fetch(`${BASE}/m/abc.png`)).status === 404);

// isolation
check('another workspace sees none of these pictures', (await call('GET', `/api/workspaces/${made.data.id}/media`, { token: O })).data.items.length === 0);
check('another workspace cannot delete them', (await call('DELETE', `/api/workspaces/${made.data.id}/media/${up.data.id}`, { token: O })).status === 404 && (await fetch(up.data.url)).status === 200);
check('cross-workspace access is refused outright', (await call('GET', '/api/workspaces/1/media', { token: O })).status === 403);

// deleting a picture that emails use
await call('POST', '/api/workspaces/1/templates', { token: A, body: { name: 'Uses picture', html: `<img src="${up.data.url}">` } });
const used = await call('DELETE', `/api/workspaces/1/media/${up.data.id}`, { token: A });
check('deleting a picture in use warns first', used.status === 409 && used.data.used_in === 1 && (await fetch(up.data.url)).status === 200, JSON.stringify(used));
check('it can still be deleted on purpose', (await call('DELETE', `/api/workspaces/1/media/${up.data.id}?force=1`, { token: A })).status === 200 && (await fetch(up.data.url)).status === 404);
const other = list.items.find((i) => i.name === 'a');
check('unused pictures delete straight away', (await call('DELETE', `/api/workspaces/1/media/${other.id}`, { token: A })).status === 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
