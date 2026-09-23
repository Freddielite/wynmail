import crypto from 'crypto';
import express, { Router } from 'express';
import { many, one, query } from '../db.js';
import { rateLimit } from '../rateLimit.js';
import { cleanName } from '../validate.js';

// Pictures for emails, kept in the database so they survive restarts on any host. SVG is refused on
// purpose: it can carry scripts. Files are checked by their first bytes, not just their label.
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MAX_BYTES = 3 * 1024 * 1024;
export const MAX_FILES = 300;
export const MAX_TOTAL = 100 * 1024 * 1024;

export function sniff(b) {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export const mediaUrl = (token) => `${(process.env.PUBLIC_URL || 'http://localhost:4000').replace(/\/+$/, '')}/m/${token}`;
const view = (r) => ({ id: r.id, name: r.name, mime: r.mime, size: r.size, created_at: r.created_at, url: mediaUrl(r.token) });

const router = Router({ mergeParams: true });
const uploadLimit = rateLimit({ windowMs: 3600000, max: 80, key: (req) => `up${req.workspace.id}` });
const wid = (req) => req.workspace.id;
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

router.get('/', async (req, res) => {
  const items = await many(`SELECT id, token, name, mime, size, created_at FROM media WHERE workspace_id = $1 ORDER BY id DESC LIMIT 300`, [wid(req)]);
  const use = await one(`SELECT count(*)::int AS files, COALESCE(sum(size), 0)::bigint AS bytes FROM media WHERE workspace_id = $1`, [wid(req)]);
  res.json({ items: items.map(view), usage: { files: use.files, bytes: Number(use.bytes), max_files: MAX_FILES, max_bytes: MAX_TOTAL, max_upload: MAX_BYTES } });
});

router.post('/', uploadLimit, express.raw({ type: Object.keys(TYPES), limit: MAX_BYTES }), async (req, res) => {
  const body = req.body;
  if (!Buffer.isBuffer(body) || !body.length) return bad(res, 'Send a PNG, JPEG, GIF or WEBP picture', 415);
  const claimed = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (sniff(body) !== claimed) return bad(res, 'That file is not a real picture of the type it says it is');
  const use = await one(`SELECT count(*)::int AS files, COALESCE(sum(size), 0)::bigint AS bytes FROM media WHERE workspace_id = $1`, [wid(req)]);
  if (use.files >= MAX_FILES) return bad(res, `You have reached the limit of ${MAX_FILES} pictures. Delete some first`, 409);
  if (Number(use.bytes) + body.length > MAX_TOTAL) return bad(res, 'Your picture storage is full. Delete some pictures first', 409);

  let name = 'picture';
  try { name = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { /* keep the default */ }
  name = cleanName(name.replace(/\.[a-z0-9]{2,5}$/i, ''), 80) || 'picture';
  const token = `${crypto.randomBytes(12).toString('hex')}.${TYPES[claimed]}`;
  const row = await one(
    `INSERT INTO media (workspace_id, token, name, mime, size, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, token, name, mime, size, created_at`,
    [wid(req), token, name, claimed, body.length, body]);
  res.json(view(row));
});

router.delete('/:id', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return bad(res, 'bad id');
  const row = await one(`SELECT id, token FROM media WHERE id = $1 AND workspace_id = $2`, [Number(req.params.id), wid(req)]);
  if (!row) return bad(res, 'not found', 404);
  const like = `%/m/${row.token}%`;
  const used = await one(
    `SELECT ((SELECT count(*) FROM templates WHERE workspace_id = $1 AND html LIKE $2)
           + (SELECT count(*) FROM campaigns WHERE workspace_id = $1 AND html LIKE $2)
           + (SELECT count(*) FROM automation_steps s JOIN automations a ON a.id = s.automation_id WHERE a.workspace_id = $1 AND s.html LIKE $2))::int AS n`,
    [wid(req), like]);
  if (used.n > 0 && req.query.force !== '1') {
    return res.status(409).json({ error: `This picture is used in ${used.n} ${used.n === 1 ? 'email' : 'emails'}. Deleting it breaks the picture in them and in emails already sent`, used_in: used.n });
  }
  await query(`DELETE FROM media WHERE id = $1 AND workspace_id = $2`, [row.id, wid(req)]);
  res.json({ ok: true });
});

export default router;

// Public, unguessable, cache-friendly address that email clients load pictures from.
export const publicMedia = Router();
publicMedia.get('/m/:file', async (req, res) => {
  const file = String(req.params.file);
  if (!/^[a-f0-9]{24}\.(png|jpg|gif|webp)$/.test(file)) return res.status(404).end();
  const row = await one(`SELECT mime, data FROM media WHERE token = $1`, [file]);
  if (!row) return res.status(404).end();
  res.set({
    'Content-Type': row.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline',
    'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin'
  });
  res.end(Buffer.from(row.data));
});
