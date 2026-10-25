import { one, many, query } from './db.js';
import { upsertContact } from './contacts.js';
import { assessEmail } from './hygiene.js';
import { isEmail, normEmail } from './validate.js';
import { findEmails, normalizeSite, isFreemail, isEuDomain, registrableDomain } from './finder.js';
import { parseCsv } from './csv.js';

// Runs find jobs one site at a time (so the whole server makes about one request every 2 to 3 seconds), checks every
// address, and saves the good new ones into the workspace's Prospects list with the page they came from.

export const MAX_SITES_PER_JOB = Number(process.env.PROSPECT_MAX_SITES_PER_JOB || 100);
export const DAILY_SITES = Number(process.env.PROSPECT_DAILY_SITES || 300);

// The Prospects list never mixes with lists of people who signed up (see attachLists in contacts.js).
export async function ensureProspectsList(workspaceId) {
  const have = await one(`SELECT id FROM lists WHERE workspace_id = $1 AND kind = 'prospects' ORDER BY id LIMIT 1`, [workspaceId]);
  if (have) return have.id;
  return (await one(`INSERT INTO lists (workspace_id, name, kind) VALUES ($1, 'Prospects', 'prospects') RETURNING id`, [workspaceId])).id;
}

// Turns pasted text or a CSV into clean sites. Returns { sites, rejected }.
export function readSites({ sites, text, csv }) {
  let raw = [];
  if (Array.isArray(sites)) raw = raw.concat(sites.map(String));
  if (typeof text === 'string') raw = raw.concat(text.split(/[\r\n,;\t ]+/));
  if (typeof csv === 'string' && csv.trim()) {
    const rows = parseCsv(csv).filter((r) => r.some((c) => String(c).trim()));
    const head = (rows[0] || []).map((c) => String(c).trim().toLowerCase());
    const col = head.findIndex((h) => ['website', 'url', 'domain', 'site', 'web', 'link'].includes(h));
    const body = col >= 0 ? rows.slice(1) : rows;
    raw = raw.concat(body.map((r) => String(r[col >= 0 ? col : 0] ?? '')));
  }
  const seen = new Set(), ok = [], rejected = [];
  for (const input of raw.map((s) => s.trim()).filter(Boolean)) {
    const site = normalizeSite(input);
    if (!site) { rejected.push({ input: input.slice(0, 120), reason: 'Not a company website address' }); continue; }
    if (seen.has(site.domain)) continue; // one site per company, www or not
    seen.add(site.domain);
    ok.push(site.origin);
  }
  return { sites: ok, rejected };
}

export async function createJob(workspaceId, userId, sites) {
  const today = (await one(`SELECT count(*)::int AS n FROM prospect_sites WHERE workspace_id = $1 AND job_id IN (SELECT id FROM prospect_jobs WHERE workspace_id = $1 AND created_at > now() - interval '24 hours')`, [workspaceId])).n;
  if (today + sites.length > DAILY_SITES) {
    const err = new Error(`That would be more than ${DAILY_SITES} websites in a day. You have ${Math.max(0, DAILY_SITES - today)} left today. Go slowly: it keeps your sender reputation safe.`);
    err.status = 429; throw err;
  }
  const active = await one(`SELECT id FROM prospect_jobs WHERE workspace_id = $1 AND status IN ('queued', 'running') LIMIT 1`, [workspaceId]);
  if (active) { const err = new Error('A search is still running. Wait for it to finish, or stop it.'); err.status = 409; throw err; }
  const job = await one(`INSERT INTO prospect_jobs (workspace_id, created_by, total_sites) VALUES ($1, $2, $3) RETURNING *`, [workspaceId, userId, sites.length]);
  await query(`INSERT INTO prospect_sites (job_id, workspace_id, url) SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING`, [job.id, workspaceId, sites]);
  return job;
}

// Decides what happens to one found address. Returns { status, note, contactId }.
async function judge(workspace, email, siteHost, jobId, siteUrl, pageUrl, deps) {
  const domain = email.split('@')[1];
  if (isFreemail(domain)) return { status: 'free_email', note: 'Personal inbox (Gmail, Yahoo and the like). Not collected.' };
  if (registrableDomain(domain) !== registrableDomain(siteHost)) return null; // someone else's address on this site: ignore
  if (isEuDomain(domain) || isEuDomain(siteHost)) return { status: 'eu', note: 'EU address. Not collected: the EU rules on cold email are strict.' };
  if (!isEmail(email)) return { status: 'invalid', note: 'Not a valid address' };
  const check = await assessEmail(email, { block_disposable: true, block_role: false, check_mx: true }, deps.assess);
  if (!check.ok) return { status: 'invalid', note: check.message };
  const existing = await one(`SELECT id, status FROM contacts WHERE workspace_id = $1 AND email = $2`, [workspace.id, email]);
  const suppressed = await one(`SELECT reason FROM suppressions WHERE workspace_id = $1 AND email = $2`, [workspace.id, email]);
  if (suppressed || (existing && existing.status !== 'subscribed')) return { status: 'suppressed', note: 'Unsubscribed, bounced or marked as spam before. Never emailed again.' };
  if (existing) return { status: 'duplicate', note: 'Already in your contacts' };
  const listId = await ensureProspectsList(workspace.id);
  const contact = await upsertContact(workspace.id, { email, tags: ['prospect'], consent_source: 'prospector' }, listId, { source: 'import' }); // treated like an import: no automation starts unless it allows imports
  await query(`UPDATE contacts SET source_url = $2, source_found_at = now(), consent_at = NULL WHERE id = $1`, [contact.id, pageUrl]);
  return { status: 'saved', note: 'Saved to Prospects', contactId: contact.id };
}

async function runSite(job, siteRow, deps) {
  const workspace = await one(`SELECT * FROM workspaces WHERE id = $1`, [job.workspace_id]);
  const stopped = async () => (await one(`SELECT status FROM prospect_jobs WHERE id = $1`, [job.id]))?.status === 'cancelled';
  let cancelled = false;
  // Cancelling is noticed within a couple of seconds, without a database call on every request.
  const watch = setInterval(async () => { if (await stopped().catch(() => false)) cancelled = true; }, 2000);
  let r;
  try { r = await findEmails(siteRow.url, { ...deps.find, shouldStop: () => cancelled }); } finally { clearInterval(watch); }
  if (await stopped()) return 'cancelled';
  let found = 0, saved = 0;
  for (const { email, page } of r.emails) {
    const e = normEmail(email);
    const verdict = await judge(workspace, e, r.host || new URL(r.origin).hostname, job.id, siteRow.url, page, deps);
    if (!verdict) continue;
    const ins = await one(
      `INSERT INTO prospect_results (job_id, workspace_id, email, site_url, page_url, status, note, contact_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (job_id, email) DO NOTHING RETURNING id`,
      [job.id, job.workspace_id, e, siteRow.url, page, verdict.status, verdict.note, verdict.contactId ?? null]);
    if (ins) { found += 1; if (verdict.status === 'saved') saved += 1; }
  }
  const status = r.blocked ? 'blocked' : r.error ? 'failed' : 'done';
  const note = r.note || (found ? null : 'No business email printed on the pages checked');
  await query(`UPDATE prospect_sites SET status = $2, pages_checked = $3, note = $4 WHERE id = $1`, [siteRow.id, status, r.pages?.length || 0, note]);
  await query(`UPDATE prospect_jobs SET done_sites = done_sites + 1, found = found + $2, saved = saved + $3, heartbeat_at = now() WHERE id = $1`, [job.id, found, saved]);
  return status;
}

// Picks up the oldest waiting job and works through its sites. Safe to call from every server: one job, one worker.
let busy = false;
export async function runNextJob(deps = {}) {
  if (busy) return false;
  busy = true;
  try {
    await query(`UPDATE prospect_jobs SET status = 'queued' WHERE status = 'running' AND heartbeat_at < now() - interval '5 minutes'`); // a server died mid-job
    const job = await one(
      `UPDATE prospect_jobs SET status = 'running', started_at = COALESCE(started_at, now()), heartbeat_at = now()
       WHERE id = (SELECT id FROM prospect_jobs WHERE status = 'queued' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    if (!job) return false;
    for (;;) {
      const cur = await one(`SELECT status FROM prospect_jobs WHERE id = $1`, [job.id]);
      if (cur.status === 'cancelled') break;
      const siteRow = await one(`SELECT * FROM prospect_sites WHERE job_id = $1 AND status = 'pending' ORDER BY id LIMIT 1`, [job.id]);
      if (!siteRow) { await query(`UPDATE prospect_jobs SET status = 'done', finished_at = now() WHERE id = $1 AND status = 'running'`, [job.id]); break; }
      try {
        await runSite(job, siteRow, { find: {}, assess: {}, ...deps });
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', msg: 'prospector site failed', job: job.id, err: err.message }));
        await query(`UPDATE prospect_sites SET status = 'failed', note = 'Something went wrong reading this site' WHERE id = $1`, [siteRow.id]);
        await query(`UPDATE prospect_jobs SET done_sites = done_sites + 1, heartbeat_at = now() WHERE id = $1`, [job.id]);
      }
    }
    await query(`UPDATE prospect_sites SET status = 'skipped', note = 'Stopped' WHERE job_id = $1 AND status = 'pending'`, [job.id]);
    return true;
  } finally { busy = false; }
}

export function startProspector() {
  const timer = setInterval(() => runNextJob().catch((err) => console.error(JSON.stringify({ level: 'error', msg: 'prospector', err: err.message }))), 3000);
  timer.unref?.();
  return timer;
}

export async function cancelJob(workspaceId, jobId) {
  const job = await one(`UPDATE prospect_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND workspace_id = $2 AND status IN ('queued', 'running') RETURNING *`, [jobId, workspaceId]);
  if (job) await query(`UPDATE prospect_sites SET status = 'skipped', note = 'Stopped' WHERE job_id = $1 AND status = 'pending'`, [jobId]);
  return job;
}

export const listJobs = (workspaceId) => many(`SELECT * FROM prospect_jobs WHERE workspace_id = $1 ORDER BY id DESC LIMIT 20`, [workspaceId]);

export async function jobDetail(workspaceId, jobId) {
  const job = await one(`SELECT * FROM prospect_jobs WHERE id = $1 AND workspace_id = $2`, [jobId, workspaceId]);
  if (!job) return null;
  const sites = await many(`SELECT id, url, status, pages_checked, note FROM prospect_sites WHERE job_id = $1 ORDER BY id`, [jobId]);
  const results = await many(
    `SELECT r.id, r.email, r.site_url, r.page_url, r.status, r.note, r.found_at, r.contact_id, (c.id IS NOT NULL) AS still_saved
     FROM prospect_results r LEFT JOIN contacts c ON c.id = r.contact_id AND c.workspace_id = r.workspace_id
     WHERE r.job_id = $1 ORDER BY r.id LIMIT 2000`, [jobId]);
  return { job, sites, results };
}
