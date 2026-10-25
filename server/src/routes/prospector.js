import { Router } from 'express';
import { one } from '../db.js';
import { audit } from '../audit.js';
import { MAX_SITES_PER_JOB, DAILY_SITES, readSites, createJob, cancelJob, listJobs, jobDetail, ensureProspectsList } from '../prospector.js';

const router = Router({ mergeParams: true });
const ws = (req) => req.workspace.id;
const bad = (res, msg) => res.status(400).json({ error: msg });

router.get('/info', async (req, res) => res.json({
  max_sites: MAX_SITES_PER_JOB, daily_sites: DAILY_SITES,
  prospects_list_id: (await one(`SELECT id FROM lists WHERE workspace_id = $1 AND kind = 'prospects' LIMIT 1`, [ws(req)]))?.id || null
}));

router.get('/jobs', async (req, res) => res.json(await listJobs(ws(req))));

router.post('/jobs', async (req, res) => {
  const b = req.body || {};
  for (const k of ['text', 'csv']) if (b[k] !== undefined && (typeof b[k] !== 'string' || b[k].length > 200000)) return bad(res, `${k} is too long`);
  const { sites, rejected } = readSites(b);
  if (!sites.length) return bad(res, rejected.length ? 'None of those look like company websites' : 'Add at least one website');
  if (sites.length > MAX_SITES_PER_JOB) return bad(res, `Up to ${MAX_SITES_PER_JOB} websites at a time. You added ${sites.length}.`);
  try {
    await ensureProspectsList(ws(req));
    const job = await createJob(ws(req), req.user.uid, sites);
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
