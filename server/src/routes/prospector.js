import { Router } from 'express';
import { one } from '../db.js';
import { normalizeSite } from '../finder.js';
import { cleanText, isEmail, normEmail } from '../validate.js';
import { CATEGORIES, COUNTRIES, discoverBusinesses } from '../discover.js';
import { audit } from '../audit.js';
import { MAX_SITES_PER_JOB, DAILY_SITES, readSites, createJob, cancelJob, listJobs, jobDetail, ensureProspectsList } from '../prospector.js';

const router = Router({ mergeParams: true });
const ws = (req) => req.workspace.id;
const bad = (res, msg) => res.status(400).json({ error: msg });

const DISCOVER_DAILY = Number(process.env.PROSPECT_DISCOVER_DAILY || 20);

router.get('/info', async (req, res) => res.json({
  max_sites: MAX_SITES_PER_JOB, daily_sites: DAILY_SITES,
  categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])), countries: COUNTRIES,
  prospects_list_id: (await one(`SELECT id FROM lists WHERE workspace_id = $1 AND kind = 'prospects' LIMIT 1`, [ws(req)]))?.id || null
}));

// Find businesses by type and city. Nothing is saved: you look at the list, then start the email search on it.
router.post('/discover', async (req, res) => {
  const b = req.body || {};
  const used = (await one(`SELECT count(*)::int AS n FROM audit_log WHERE workspace_id = $1 AND action = 'prospector.discover' AND created_at > now() - interval '24 hours'`, [ws(req)])).n;
  if (used >= DISCOVER_DAILY) return res.status(429).json({ error: `You have used today's ${DISCOVER_DAILY} business searches. Try again tomorrow.` });
  try {
    const r = await discoverBusinesses({ category: b.category, city: b.city, country: String(b.country || 'NG').toUpperCase() });
    await audit(req, 'prospector.discover', { meta: { category: b.category, city: String(b.city).slice(0, 60), country: b.country, found: r.total } });
    res.json({ ...r, with_website: r.businesses.filter((x) => x.website).length, with_email: r.businesses.filter((x) => x.email).length });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.get('/jobs', async (req, res) => res.json(await listJobs(ws(req))));

router.post('/jobs', async (req, res) => {
  const b = req.body || {};
  for (const k of ['text', 'csv']) if (b[k] !== undefined && (typeof b[k] !== 'string' || b[k].length > 200000)) return bad(res, `${k} is too long`);
  let { sites, rejected } = readSites(b);
  // Businesses picked from a search carry their name, phone, type and city along, and may already list an email.
  if (Array.isArray(b.businesses)) {
    const seen = new Set(sites);
    for (const x of b.businesses.slice(0, MAX_SITES_PER_JOB + 1)) {
      const site = x?.website ? normalizeSite(String(x.website)) : null;
      const email = x?.email && isEmail(normEmail(x.email)) ? normEmail(x.email) : null;
      const page = typeof x?.listed_page === 'string' && /^https:\/\/www\.openstreetmap\.org\/(node|way|relation)\/\d+$/.test(x.listed_page) ? x.listed_page : null;
      const url = site ? site.origin : (email && page ? page : null);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sites.push({ url, company: cleanText(x.name, 100) || null, phone: cleanText(x.phone, 30) || null, category: cleanText(x.category, 60) || null, city: cleanText(x.city, 60) || null, email, listed_page: page });
    }
  }
  if (!sites.length) return bad(res, rejected.length ? 'None of those look like company websites' : 'Add at least one website');
  if (sites.length > MAX_SITES_PER_JOB) return bad(res, `Up to ${MAX_SITES_PER_JOB} websites at a time. You added ${sites.length}.`);
  try {
    await ensureProspectsList(ws(req));
    const job = await createJob(ws(req), req.user.uid, sites, { perCompany: b.per_company ?? 2 });
    await audit(req, 'prospector.job_created', { target: job.id, meta: { sites: sites.length } });
    res.json({ job, rejected: rejected.slice(0, 50), rejected_count: rejected.length });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.get('/jobs/:id', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return bad(res, 'bad id');
  const d = await jobDetail(ws(req), Number(req.params.id));
  return d ? res.json(d) : res.status(404).json({ error: 'not found' });
});

router.post('/jobs/:id/cancel', async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id)) return bad(res, 'bad id');
  const job = await cancelJob(ws(req), Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'That search is not running' });
  await audit(req, 'prospector.job_cancelled', { target: job.id });
  res.json({ ok: true });
});

export default router;
