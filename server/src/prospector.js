import { one, many, query } from './db.js';
import { upsertContact } from './contacts.js';
import { assessEmail } from './hygiene.js';
import { isEmail, normEmail } from './validate.js';
import { findEmails, normalizeSite, isFreemail, isEuDomain, registrableDomain, classifyAddress, scoreLead } from './finder.js';
import { cleanText } from './validate.js';
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

// sites: ['https://acme.ng', ...] or [{ url, company, phone, category, city, email, listed_page }] from the business search.
export async function createJob(workspaceId, userId, sites, { perCompany = 2 } = {}) {
  const items = sites.map((x) => (typeof x === 'string' ? { url: x } : x));
  const today = (await one(`SELECT count(*)::int AS n FROM prospect_sites WHERE workspace_id = $1 AND job_id IN (SELECT id FROM prospect_jobs WHERE workspace_id = $1 AND created_at > now() - interval '24 hours')`, [workspaceId])).n;
  if (today + items.length > DAILY_SITES) {
    const err = new Error(`That would be more than ${DAILY_SITES} websites in a day. You have ${Math.max(0, DAILY_SITES - today)} left today. Go slowly: it keeps your sender reputation safe.`);
    err.status = 429; throw err;
  }
  const active = await one(`SELECT id FROM prospect_jobs WHERE workspace_id = $1 AND status IN ('queued', 'running') LIMIT 1`, [workspaceId]);
  if (active) { const err = new Error('A search is still running. Wait for it to finish, or stop it.'); err.status = 409; throw err; }
  const per = [0, 1, 2, 3].includes(Number(perCompany)) ? Number(perCompany) : 2;
  const job = await one(`INSERT INTO prospect_jobs (workspace_id, created_by, total_sites, per_company) VALUES ($1, $2, $3, $4) RETURNING *`, [workspaceId, userId, items.length, per]);
  for (const x of items) {
    await query(
      `INSERT INTO prospect_sites (job_id, workspace_id, url, company, phone, category, city, listed_email, listed_page, via) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
      [job.id, workspaceId, x.url, x.company || null, x.phone || null, x.category || null, x.city || null, x.email || null, x.listed_page || null, x.listed_page ? 'openstreetmap' : 'website']);
  }
  return job;
}

// Decides whether one found address can be kept. Returns { status, note } and, for a keeper, status 'ok' plus its details.
async function check(workspace, email, siteHost, deps) {
  const domain = email.split('@')[1];
  // Gmail, Yahoo and other free inboxes are kept: many small businesses print one as their contact address.
  // An address at some other company (a web designer, the hosting company) is not this business's: ignore it.
  if (!isFreemail(domain) && registrableDomain(domain) !== registrableDomain(siteHost)) return null;
  if (isEuDomain(domain) || isEuDomain(siteHost)) return { status: 'eu', note: 'EU address. Not collected: the EU rules on cold email are strict.' };
  if (!isEmail(email)) return { status: 'invalid', note: 'Not a valid address' };
  const verdict = await assessEmail(email, { block_disposable: true, block_role: false, check_mx: true }, deps.assess);
  if (!verdict.ok) return { status: 'invalid', note: verdict.message };
  const existing = await one(`SELECT id, status FROM contacts WHERE workspace_id = $1 AND email = $2`, [workspace.id, email]);
  const suppressed = await one(`SELECT reason FROM suppressions WHERE workspace_id = $1 AND email = $2`, [workspace.id, email]);
  if (suppressed || (existing && existing.status !== 'subscribed')) return { status: 'suppressed', note: 'Unsubscribed, bounced or marked as spam before. Never emailed again.' };
  if (existing) return { status: 'duplicate', note: 'Already in your contacts' };
  return { status: 'ok', free: isFreemail(domain) };
}

async function save(workspace, c, listId) {
  const attrs = { website: c.website, ...(c.company ? { company: c.company } : {}), ...(c.phone ? { phone: c.phone } : {}), ...(c.category ? { category: c.category } : {}), ...(c.city ? { city: c.city } : {}), found_via: c.via };
  const contact = await upsertContact(workspace.id,
    { email: c.email, first_name: c.first_name, last_name: c.last_name, attributes: attrs, tags: ['prospect', c.kind], consent_source: 'prospector' },
    listId, { source: 'import' }); // treated like an import: no automation starts unless it allows imports
  await query(`UPDATE contacts SET source_url = $2, source_found_at = now(), consent_at = NULL WHERE id = $1`, [contact.id, c.page]);
  return contact.id;
}

async function runSite(job, siteRow, deps) {
  const workspace = await one(`SELECT * FROM workspaces WHERE id = $1`, [job.workspace_id]);
  const stopped = async () => (await one(`SELECT status FROM prospect_jobs WHERE id = $1`, [job.id]))?.status === 'cancelled';
  let cancelled = false;
  // Cancelling is noticed within a couple of seconds, without a database call on every request.
  const watch = setInterval(async () => { if (await stopped().catch(() => false)) cancelled = true; }, 2000);
  const siteless = /^https:\/\/www\.openstreetmap\.org\//.test(siteRow.url); // a listed business with an email but no website
  let r;
  try { r = siteless ? { origin: siteRow.url, host: null, pages: [], emails: [] } : await findEmails(siteRow.url, { ...deps.find, shouldStop: () => cancelled }); } finally { clearInterval(watch); }
  if (await stopped()) return 'cancelled';

  const host = siteless ? null : (r.host || new URL(r.origin).hostname);
  const candidates = [...r.emails];
  if (siteRow.listed_email && !candidates.some((x) => x.email === siteRow.listed_email)) candidates.push({ email: siteRow.listed_email, page: siteRow.listed_page || siteRow.url });
  const company = siteRow.company || r.company || null, phone = siteRow.phone || r.phone || null;

  // Judge every address first, then keep only the best few per company.
  const keepers = [], rejected = [];
  for (const { email, page } of candidates) {
    const e = normEmail(email);
    const sameSiteHost = host || e.split('@')[1]; // a business with no website: its own listed address is the company
    const v = await check(workspace, e, sameSiteHost, deps);
    if (!v) continue;
    if (v.status !== 'ok') { rejected.push({ email: e, page, ...v }); continue; }
    const cls = classifyAddress(e);
    keepers.push({ email: e, page, kind: cls.kind, first_name: cls.first_name, last_name: cls.last_name, free: v.free, company, phone,
      category: siteRow.category, city: siteRow.city, website: siteless ? null : siteRow.url, via: siteRow.via,
      score: scoreLead({ kind: cls.kind, free: v.free, company, phone }) });
  }
  keepers.sort((a, b) => b.score - a.score);
  const limit = job.per_company || 0; // 0 means keep them all
  const listId = keepers.length ? await ensureProspectsList(workspace.id) : null;
  let found = 0, saved = 0;
  const record = async (x, status, note, contactId) => {
    const ins = await one(
      `INSERT INTO prospect_results (job_id, workspace_id, email, site_url, page_url, status, note, contact_id, company, kind, score, phone) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (job_id, email) DO NOTHING RETURNING id`,
      [job.id, job.workspace_id, x.email, siteRow.url, x.page, status, note, contactId ?? null, x.company ?? company, x.kind ?? null, x.score ?? null, x.phone ?? phone]);
    if (ins) { found += 1; if (status === 'saved') saved += 1; }
  };
  for (const [i, k] of keepers.entries()) {
    if (limit && i >= limit) { await record(k, 'extra', 'Another address at the same company. Kept out so one business is not over-emailed.'); continue; }
    await record(k, 'saved', 'Saved to Prospects', await save(workspace, k, listId));
  }
  for (const x of rejected) await record(x, x.status, x.note);

  const status = r.blocked ? 'blocked' : r.error ? 'failed' : 'done';
  const note = r.note || (found ? null : 'No business email printed on the pages checked');
  await query(`UPDATE prospect_sites SET status = $2, pages_checked = $3, note = $4, company = COALESCE(company, $5), phone = COALESCE(phone, $6) WHERE id = $1`, [siteRow.id, status, r.pages?.length || 0, note, company, phone]);
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
  const sites = await many(`SELECT id, url, status, pages_checked, note, company, phone, category, city, via FROM prospect_sites WHERE job_id = $1 ORDER BY id`, [jobId]);
  const results = await many(
    `SELECT r.id, r.email, r.site_url, r.page_url, r.status, r.note, r.found_at, r.contact_id, r.company, r.kind, r.score, r.phone, (c.id IS NOT NULL) AS still_saved
     FROM prospect_results r LEFT JOIN contacts c ON c.id = r.contact_id AND c.workspace_id = r.workspace_id
     WHERE r.job_id = $1 ORDER BY (r.status = 'saved') DESC, r.score DESC NULLS LAST, r.id LIMIT 2000`, [jobId]);
  return { job, sites, results };
}
