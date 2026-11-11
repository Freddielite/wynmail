// The sending queue must never stall: one broken workspace, a provider that never answers, or a
// failure in the middle of a batch must not stop other emails from going out, and a campaign that
// did not go out can be retried safely. Run alone: node test/queue-resilience.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
process.env.USE_PGLITE = '1';
process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-'));
process.env.SEND_GAP_MS = '5';
process.env.SEND_TIMEOUT_MS = '300';
process.env.QUEUE_TICK_MS = '60000';
delete process.env.FORCE_PROVIDER;

const { migrate, many, one, query } = await import('../src/db.js');
const { drainOnce, retryCampaign, queueHealth } = await import('../src/queue.js');
const { registerProvider } = await import('../src/providers/index.js');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '   ' + extra)); };

await migrate();

let n = 0;
async function workspace(provider) {
  n++;
  return one(
    `INSERT INTO workspaces (name, slug, sending_domain, from_name, from_email, footer_address, provider)
     VALUES ($1, $2, 'mail.test.dev', 'Test', 'hi@mail.test.dev', '1 Test St', $3) RETURNING *`,
    [`W${n}`, `w${n}`, provider]);
}
async function contact(ws, email, status = 'subscribed') {
  return one(`INSERT INTO contacts (workspace_id, email, status, consent_source) VALUES ($1, $2, $3, 'test') RETURNING *`, [ws.id, email, status]);
}
async function campaign(ws, status = 'sending') {
  return one(`INSERT INTO campaigns (workspace_id, name, subject, html, status) VALUES ($1, 'c', 'Hello', '<p>Hi</p>', $2) RETURNING *`, [ws.id, status]);
}
let tok = 0;
async function message(ws, camp, ct, fields = {}) {
  const f = { status: 'queued', attempts: 0, ...fields };
  return one(
    `INSERT INTO messages (workspace_id, campaign_id, contact_id, email, token, status, attempts, error, claimed_at, sent_at, bounced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [ws.id, camp.id, ct.id, ct.email, `tok${++tok}`, f.status, f.attempts, f.error || null, f.claimed_at || null, f.sent_at || null, f.bounced_at || null]);
}
const status = async (id) => (await one(`SELECT status, attempts, error, send_after FROM messages WHERE id = $1`, [id]));
const sentTo = [];
registerProvider('ok', { async send(m) { sentTo.push(m.to); return { id: 'p-' + m.to }; } });

// 1. A provider call that never answers is cut off, the message waits for another try, and the rest still go out.
{
  let calls = 0;
  registerProvider('flaky', { async send(m) { calls++; if (calls === 1) return new Promise(() => {}); sentTo.push(m.to); return { id: 'p' }; } });
  const ws = await workspace('flaky');
  const camp = await campaign(ws);
  const a = await message(ws, camp, await contact(ws, 'a@x.dev'));
  const b = await message(ws, camp, await contact(ws, 'b@x.dev'));
  const t0 = Date.now();
  await drainOnce();
  const took = Date.now() - t0;
  const A = await status(a.id), B = await status(b.id);
  check('a hung provider call is cut off within the limit (took ' + took + 'ms)', took < 3000, String(took));
  check('the message that hung goes back to waiting, one attempt used', A.status === 'queued' && A.attempts === 1, JSON.stringify(A));
  check('the hung message waits before its next try (no instant retry)', A.send_after && new Date(A.send_after).getTime() > Date.now() + 10000, String(A.send_after));
  check('the next message in the same batch still went out', B.status === 'sent', JSON.stringify(B));
  check('the campaign is not marked finished while one is still waiting', (await one(`SELECT status FROM campaigns WHERE id = $1`, [camp.id])).status === 'sending');
}

// 2. A generic provider failure waits 30 seconds before the second try instead of failing three times in 15 seconds.
{
  registerProvider('down', { async send() { throw new Error('503 Service Unavailable'); } });
  const ws = await workspace('down');
  const camp = await campaign(ws);
  const m = await message(ws, camp, await contact(ws, 'c@x.dev'));
  await drainOnce();
  const s = await status(m.id);
  check('first failure: queued again, not failed', s.status === 'queued' && s.attempts === 1, JSON.stringify(s));
  check('and not retried straight away', s.send_after && new Date(s.send_after).getTime() > Date.now() + 10000, String(s.send_after));
  await drainOnce();
  check('a second round right after does not touch it', (await status(m.id)).attempts === 1);
}

// 3. One broken workspace does not stop the others.
{
  const broken = await workspace('smtp');   // sends through its own mailboxes ...
  const goodWs = await workspace('ok');
  const bc = await campaign(broken);
  await message(broken, bc, await contact(broken, 'z@x.dev'));
  const gc = await campaign(goodWs);
  const g = await message(goodWs, gc, await contact(goodWs, 'good@x.dev'));
  await query(`DROP TABLE mailboxes CASCADE`);  // ... and its mailbox lookup now fails every round
  await drainOnce();
  check('the healthy workspace still sent although another one errors every round', (await status(g.id)).status === 'sent');
  check('and its campaign finished', (await one(`SELECT status FROM campaigns WHERE id = $1`, [gc.id])).status === 'sent');
}

// 4. Retry puts back only what did not go out.
{
  const ws = await workspace('ok');
  const camp = await campaign(ws, 'sent');
  const ago = new Date(Date.now() - 20 * 60000).toISOString();
  const sent = await message(ws, camp, await contact(ws, 'sent@x.dev'), { status: 'sent', sent_at: ago });
  const failed = await message(ws, camp, await contact(ws, 'failed@x.dev'), { status: 'failed', attempts: 3, error: 'timed out' });
  const stuck = await message(ws, camp, await contact(ws, 'stuck@x.dev'), { status: 'sending', claimed_at: ago });
  const bounced = await message(ws, camp, await contact(ws, 'bounced@x.dev'), { status: 'failed', attempts: 1, bounced_at: ago });
  const left = await message(ws, camp, await contact(ws, 'left@x.dev', 'unsubscribed'), { status: 'failed', attempts: 3 });
  const fresh = await message(ws, camp, await contact(ws, 'fresh@x.dev'), { status: 'sending', claimed_at: new Date().toISOString() });

  const out = await retryCampaign(camp.id, ws.id);
  check('retry puts back the failed one and the one stuck mid-send (2)', out.requeued === 2, JSON.stringify(out));
  check('the campaign is sending again', (await one(`SELECT status FROM campaigns WHERE id = $1`, [camp.id])).status === 'sending');
  check('someone who already got it is not queued again', (await status(sent.id)).status === 'sent');
  check('a hard bounce is not retried', (await status(bounced.id)).status === 'failed');
  check('someone who unsubscribed is not retried', (await status(left.id)).status === 'failed');
  check('a message another round is sending right now is left alone', (await status(fresh.id)).status === 'sending');
  sentTo.length = 0;
  await drainOnce();
  check('the retried emails were sent', sentTo.includes('failed@x.dev') && sentTo.includes('stuck@x.dev') && sentTo.length === 2, sentTo.join(','));
  check('and attempts start again from zero', (await status(failed.id)).status === 'sent');
  await query(`UPDATE messages SET status = 'sent', sent_at = now() WHERE id = $1`, [fresh.id]);
  await drainOnce();
  check('the campaign finishes once nothing is waiting', (await one(`SELECT status FROM campaigns WHERE id = $1`, [camp.id])).status === 'sent');
  check('a second retry finds nothing to do', (await retryCampaign(camp.id, ws.id)).requeued === 0);
}

// 5. Retry refuses what it should.
{
  const ws = await workspace('ok');
  const draft = await campaign(ws, 'draft');
  let msg = '';
  await retryCampaign(draft.id, ws.id).catch((e) => { msg = e.message; });
  check('a draft cannot be retried', /has been sent/.test(msg), msg);
  const other = await workspace('ok');
  let code = 0;
  await retryCampaign(draft.id, other.id).catch((e) => { code = e.status; });
  check('another workspace cannot retry it', code === 404, String(code));
  const paused = await campaign(ws, 'sending');
  await query(`UPDATE campaigns SET paused_reason = 'complaints' WHERE id = $1`, [paused.id]);
  let pmsg = '';
  await retryCampaign(paused.id, ws.id).catch((e) => { pmsg = e.message; });
  check('a campaign paused for reputation is not pushed on', /paused/.test(pmsg), pmsg);
}

// 6. Health
{
  const h = queueHealth();
  check('queue health is readable before the worker starts', h.started === false && h.running === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
