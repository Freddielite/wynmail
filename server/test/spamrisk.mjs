// Learning loop and live pause, run in-process on a scratch database (no server needed).
import fs from 'fs';
import os from 'os';
import path from 'path';
process.env.USE_PGLITE = '1';
process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-'));
process.env.FORCE_PROVIDER = 'console';
const { migrate, query, one, many } = await import('../src/db.js');
const { learn, assess, train, predict, features, isBad, retrain } = await import('../src/spamrisk.js');
const { guardRunning } = await import('../src/queue.js');
await migrate();

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

check('a campaign with complaints is bad', isBad({ sent: 100, complaint_rate: 0.004, bounce_rate: 0, open_rate: 0.3 }, 0.3));
check('a campaign with many hard bounces is bad', isBad({ sent: 100, complaint_rate: 0, bounce_rate: 0.08, open_rate: 0.3 }, 0.3));
check('opens far below this workspace\'s normal is bad', isBad({ sent: 100, complaint_rate: 0, bounce_rate: 0, open_rate: 0.05 }, 0.3));
check('a healthy campaign is not bad', !isBad({ sent: 100, complaint_rate: 0, bounce_rate: 0.01, open_rate: 0.28 }, 0.3));
check('tiny sends say nothing', !isBad({ sent: 10, complaint_rate: 0.3, bounce_rate: 0, open_rate: 0 }, 0.3));

const ws = await one(`INSERT INTO workspaces (name, slug, from_email, sending_domain, footer_address) VALUES ('T', 'testws', 'a@t.ng', 't.ng', 'x') RETURNING *`);
await query(`INSERT INTO users (email, password_hash) VALUES ('o@t.ng', 'x')`);
await query(`INSERT INTO memberships (user_id, workspace_id, role) SELECT id, $1, 'owner' FROM users WHERE email = 'o@t.ng'`, [ws.id]);

const spammy = (i) => ({ subject: `FREE!!! WIN $$$ NOW ${i}`, html: '<p>Act now, limited time, 100% free, click here, buy now, cash bonus, winner, risk free</p><a href="http://bit.ly/a">here</a><a href="http://bit.ly/b">here</a>' });
const clean = (i) => ({ subject: `Our newsletter number ${i}`, html: '<p>Hello, here is what we shipped this month with the details of every change we made to the editor and the reports page.</p><a href="https://t.ng/news">Read more</a>' });

async function seedCampaign({ subject, html }, { sent = 60, complained = 0, opened = 30, status = 'sent', finishedDaysAgo = 3, queued = 0 }) {
  const c = await one(`INSERT INTO campaigns (workspace_id, name, subject, html, status, finished_at, started_at) VALUES ($1, 'c', $2, $3, $4, ${status === 'sent' ? `now() - interval '${finishedDaysAgo} days'` : 'NULL'}, now() - interval '4 days') RETURNING id`, [ws.id, subject, html, status]);
  for (let i = 0; i < sent + queued; i++) {
    const isSent = i < sent;
    await query(`INSERT INTO messages (workspace_id, campaign_id, email, token, status, sent_at, opened_at, complained_at) VALUES ($1, $2, $3, $4, $5, ${isSent ? 'now()' : 'NULL'}, $6, $7)`,
      [ws.id, c.id, `p${c.id}_${i}@x.com`, `t${c.id}_${i}_${Math.random()}`, isSent ? 'sent' : 'queued', isSent && i < opened ? new Date() : null, isSent && i < complained ? new Date() : null]);
  }
  return c.id;
}

// 6 clean campaigns that did fine, 6 spammy ones that got complaints or no opens
for (let i = 0; i < 6; i++) await seedCampaign(clean(i), { opened: 30 });
for (let i = 0; i < 6; i++) await seedCampaign(spammy(i), { opened: 4, complained: i % 2 ? 1 : 0 });
await seedCampaign(clean(99), { sent: 10 }); // too small to learn from

const before = await assess(ws, spammy(100));
check('before learning, the estimate comes from the rules alone', before.learned === null && before.samples === 0);
const out = await learn();
check('every sizeable finished campaign was recorded once', out.learned === 12 && (await one(`SELECT count(*)::int AS n FROM campaign_outcomes`)).n === 12, JSON.stringify(out));
check('spammy campaigns were labelled bad, clean ones good', (await many(`SELECT bad FROM campaign_outcomes ORDER BY campaign_id`)).map((r) => r.bad).join() === 'false,false,false,false,false,false,true,true,true,true,true,true');
check('a model was trained for the workspace', (await one(`SELECT samples FROM spam_models WHERE workspace_id = $1`, [ws.id]))?.samples === 12);
check('running it again learns nothing new', (await learn()).learned === 0);

const bad = await assess(ws, spammy(101)), good = await assess(ws, clean(101));
check('after learning, the model has a say', bad.learned !== null && bad.learned_weight > 0, JSON.stringify(bad));
check('spammy scores far above clean', bad.risk >= 60 && good.risk < 30 && bad.risk - good.risk >= 40, `${bad.risk} vs ${good.risk}`);
check('the model can explain what it learned', bad.reasons.some((r) => r.level === 'learned' || r.level === 'warn'));
const m = (await one(`SELECT weights FROM spam_models WHERE workspace_id = $1`, [ws.id])).weights;
check('the trained model separates the data', predict(m, features(spammy(7))).p > 0.7 && predict(m, features(clean(7))).p < 0.3);
check('too little data trains nothing', (await retrain(ws.id + 1)) === null);
check('train() never crashes on one-sided data', (() => { try { train([{ features: features(clean(1)), bad: false }, { features: features(clean(2)), bad: false }]); return true; } catch { return false; } })());

// live pause: 60 sent, 2 complaints (3.3%), 40 still queued
const live = await seedCampaign(spammy(200), { status: 'sending', sent: 60, complained: 2, queued: 40 });
const healthy = await seedCampaign(clean(200), { status: 'sending', sent: 60, complained: 0, queued: 40 });
const tiny = await seedCampaign(spammy(201), { status: 'sending', sent: 20, complained: 5, queued: 10 });
await guardRunning();
check('a campaign with a complaint spike is paused', (await one(`SELECT paused_reason FROM campaigns WHERE id = $1`, [live])).paused_reason?.includes('marked it as spam'));
check('its unsent emails are stopped, not deleted', (await one(`SELECT count(*)::int AS n FROM messages WHERE campaign_id = $1 AND status = 'paused'`, [live])).n === 40);
check('a healthy campaign is left alone', (await one(`SELECT paused_reason FROM campaigns WHERE id = $1`, [healthy])).paused_reason === null);
check('too few sends to judge is left alone', (await one(`SELECT paused_reason FROM campaigns WHERE id = $1`, [tiny])).paused_reason === null);
check('the owner was notified', (await one(`SELECT count(*)::int AS n FROM notifications WHERE campaign_id = $1 AND kind = 'paused'`, [live])).n === 1);
check('a paused campaign does not count as finished', (await query(`UPDATE campaigns SET status = 'sent', finished_at = now() WHERE status = 'sending' AND id = $1 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.campaign_id = campaigns.id AND m.status IN ('queued','sending','held','paused')) RETURNING id`, [live])).rows.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
