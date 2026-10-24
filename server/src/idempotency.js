import crypto from 'crypto';
import { one, query } from './db.js';

const KEY_RE = /^[\w.:-]{8,100}$/;
const hashBody = (body) => crypto.createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');

// Wraps a POST so a retried request with the same Idempotency-Key replays the first answer instead of acting twice.
// No header means no change in behaviour.
export function idempotent(handler) {
  return async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key) return handler(req, res);
    if (!KEY_RE.test(key)) return res.status(400).json({ error: 'Idempotency-Key must be 8 to 100 characters: letters, numbers, . _ : -' });

    const wid = req.workspace.id, h = hashBody(req.body);
    const claimed = await one(
      `INSERT INTO idempotency_keys (workspace_id, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING key`, [wid, key, h]);
    if (!claimed) {
      const prior = await one(`SELECT request_hash, status_code, response FROM idempotency_keys WHERE workspace_id = $1 AND key = $2`, [wid, key]);
      if (!prior) return handler(req, res);
      if (prior.request_hash !== h) return res.status(422).json({ error: 'This Idempotency-Key was already used with a different request.' });
      if (prior.status_code === null) return res.status(409).json({ error: 'A request with this Idempotency-Key is still being processed.' });
      return res.status(prior.status_code).set('Idempotent-Replayed', 'true').json(prior.response);
    }

    // Capture the answer the handler sends, store it, and let it through.
    const send = res.json.bind(res);
    res.json = (body) => {
      // A transient failure (provider down, 5xx) is not cached, so the client can retry with the same key.
      const p = res.statusCode >= 500
        ? query(`DELETE FROM idempotency_keys WHERE workspace_id = $1 AND key = $2`, [wid, key])
        : query(`UPDATE idempotency_keys SET status_code = $3, response = $4::jsonb WHERE workspace_id = $1 AND key = $2`, [wid, key, res.statusCode, JSON.stringify(body)]);
      p.catch(() => {}).finally(() => send(body));
      return res;
    };
    try { await handler(req, res); } catch (err) {
      await query(`DELETE FROM idempotency_keys WHERE workspace_id = $1 AND key = $2`, [wid, key]).catch(() => {});
      throw err;
    }
  };
}
