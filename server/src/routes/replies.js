import { Router } from 'express';
import { one, many, query } from '../db.js';
import { audit } from '../audit.js';

// What came back from your prospects: replies, removal requests, out-of-office notes and bounces.
const router = Router({ mergeParams: true });
const ws = (req) => req.workspace.id;

router.get('/', async (req, res) => {
  const kinds = ['reply', 'unsubscribe', 'auto_reply', 'bounce', 'bounce_soft'];
  const kind = kinds.includes(req.query.kind) ? req.query.kind : null;
  const rows = await many(
    `SELECT r.id, r.kind, r.from_email, r.subject, r.snippet, r.received_at, r.handled, r.contact_id,
            c.attributes->>'company' AS company, c.first_name, c.last_name
     FROM replies r LEFT JOIN contacts c ON c.id = r.contact_id
     WHERE r.workspace_id = $1 AND ($2::text IS NULL OR r.kind = $2) ORDER BY r.received_at DESC, r.id DESC LIMIT 200`, [ws(req), kind]);
  const open = await one(`SELECT count(*)::int AS n FROM replies WHERE workspace_id = $1 AND kind IN ('reply', 'unsubscribe') AND NOT handled`, [ws(req)]);
  res.json({ replies: rows, needs_attention: open.n });
});

router.post('/:id/handled', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const r = await one(`UPDATE replies SET handled = $3 WHERE id = $1 AND workspace_id = $2 RETURNING id, handled`, [req.params.id, ws(req), req.body?.handled !== false]);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

export default router;
