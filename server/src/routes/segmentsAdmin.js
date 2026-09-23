import { Router } from 'express';
import { many, one, query } from '../db.js';
import { cleanName } from '../validate.js';
import { readSegment, compileSegment } from '../segments.js';

const router = Router({ mergeParams: true });
const wid = (req) => req.workspace.id;
const bad = (res, msg) => res.status(400).json({ error: msg });
const MAX_SEGMENTS = 30;

export async function countSegment(workspaceId, def, sample = 0) {
  const params = [workspaceId];
  const cond = compileSegment(def, params);
  const c = await one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE c.status = 'subscribed')::int AS subscribed FROM contacts c WHERE c.workspace_id = $1 AND ${cond}`, params);
  const people = sample
    ? await many(`SELECT c.id, c.email, c.first_name, c.last_name, c.status FROM contacts c WHERE c.workspace_id = $1 AND ${cond} ORDER BY c.id DESC LIMIT ${Number(sample)}`, params)
    : [];
  return { ...c, sample: people };
}

router.get('/', async (req, res) => {
  const rows = await many(`SELECT id, name, definition, created_at FROM segments WHERE workspace_id = $1 ORDER BY id DESC`, [wid(req)]);
  const out = [];
  for (const r of rows) { const c = await countSegment(wid(req), r.definition); out.push({ ...r, total: c.total, subscribed: c.subscribed }); }
  res.json(out);
});

// Live count while someone is still building the rules.
router.post('/preview', async (req, res) => {
  const { value, error } = await readSegment(req.body?.definition, wid(req));
  if (error) return bad(res, error);
  res.json(await countSegment(wid(req), value, 10));
});

router.post('/', async (req, res) => {
  const name = cleanName(req.body?.name, 80);
  if (!name) return bad(res, 'Give the segment a name');
  const { value, error } = await readSegment(req.body?.definition, wid(req));
  if (error) return bad(res, error);
  const { n } = await one(`SELECT count(*)::int AS n FROM segments WHERE workspace_id = $1`, [wid(req)]);
  if (n >= MAX_SEGMENTS) return bad(res, `A workspace can have at most ${MAX_SEGMENTS} segments`);
  res.json(await one(`INSERT INTO segments (workspace_id, name, definition) VALUES ($1, $2, $3::jsonb) RETURNING *`, [wid(req), name, JSON.stringify(value)]));
});

router.get('/:id', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return bad(res, 'bad id');
  const s = await one(`SELECT * FROM segments WHERE id = $1 AND workspace_id = $2`, [Number(req.params.id), wid(req)]);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({ ...s, ...(await countSegment(wid(req), s.definition, 10)) });
});

router.put('/:id', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return bad(res, 'bad id');
  const name = cleanName(req.body?.name, 80);
  if (!name) return bad(res, 'Give the segment a name');
  const { value, error } = await readSegment(req.body?.definition, wid(req));
  if (error) return bad(res, error);
  const row = await one(`UPDATE segments SET name = $3, definition = $4::jsonb WHERE id = $1 AND workspace_id = $2 RETURNING *`, [Number(req.params.id), wid(req), name, JSON.stringify(value)]);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

router.delete('/:id', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return bad(res, 'bad id');
  await query(`DELETE FROM segments WHERE id = $1 AND workspace_id = $2`, [Number(req.params.id), wid(req)]);
  res.json({ ok: true });
});

export default router;
