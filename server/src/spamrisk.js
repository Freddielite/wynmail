import { analyze, score, textOf, extractLinks, extractImages, SPAM_PHRASES } from './precheck.js';
import { one, many, query } from './db.js';

// Estimates how likely an email is to be treated as spam, and learns from this workspace's own sends.
// Nothing can see the spam folder, so "bad" means what the inbox providers tell us: complaints, hard bounces,
// and opens far below this workspace's normal. A rule-based estimate is used until there is enough history.

const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy'];
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const ratio = (s, re) => { const l = s.replace(/[^A-Za-z]/g, ''); return l.length < 6 ? 0 : (l.match(re) || []).length / l.length; };

export const FEATURES = ['subj_len', 'subj_caps', 'subj_punct', 'subj_spam', 'subj_money', 'body_words', 'body_spam', 'body_caps', 'img_heavy', 'links', 'shorteners', 'insecure_links', 'html_kb'];

export function features({ subject = '', html = '' }) {
  const subj = String(subject), text = textOf(html), lower = text.toLowerCase(), words = text.split(/\s+/).filter(Boolean).length;
  const links = extractLinks(html).filter((l) => /^https?:\/\//i.test(l.href));
  const imgs = extractImages(html).length;
  return {
    subj_len: Math.min(subj.length, 120) / 120,
    subj_caps: ratio(subj, /[A-Z]/g),
    subj_punct: Math.min((subj.match(/[!?]/g) || []).length, 5) / 5,
    subj_spam: Math.min(SPAM_PHRASES.filter((p) => subj.toLowerCase().includes(p)).length, 4) / 4,
    subj_money: /[$£€₦%]|\bfree\b|\b\d+%/i.test(subj) ? 1 : 0,
    body_words: Math.min(Math.log10(words + 1), 4) / 4,
    body_spam: Math.min(SPAM_PHRASES.filter((p) => lower.includes(p)).length, 8) / 8,
    body_caps: ratio(text, /[A-Z]/g),
    img_heavy: imgs ? Math.min(imgs / (words / 40 + 1), 5) / 5 : 0,
    links: Math.min(links.length, 30) / 30,
    shorteners: Math.min(links.filter((l) => SHORTENERS.includes(hostOf(l.href))).length, 5) / 5,
    insecure_links: Math.min(links.filter((l) => /^http:/i.test(l.href)).length, 5) / 5,
    html_kb: Math.min(Buffer.byteLength(String(html)) / 1024, 200) / 200
  };
}

const REASON = {
  subj_len: 'The subject is long', subj_caps: 'The subject has a lot of capital letters', subj_punct: 'The subject has exclamation or question marks',
  subj_spam: 'The subject uses spam trigger words', subj_money: 'The subject talks about money, percentages or "free"',
  body_words: 'The email has very little text', body_spam: 'The text uses spam trigger phrases', body_caps: 'The text has a lot of capital letters',
  img_heavy: 'The email is mostly pictures', links: 'The email has many links', shorteners: 'The email uses link shorteners',
  insecure_links: 'Some links are not https', html_kb: 'The email is very large'
};

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const vec = (f) => FEATURES.map((k) => f[k] ?? 0);

// Plain logistic regression, trained in a few hundred steps. Small data, so it stays small and explainable.
export function train(rows) {
  const X = rows.map((r) => vec(r.features)), y = rows.map((r) => (r.bad ? 1 : 0));
  const n = X.length, d = FEATURES.length;
  const mean = FEATURES.map((_, j) => X.reduce((s, x) => s + x[j], 0) / n);
  const std = FEATURES.map((_, j) => Math.sqrt(X.reduce((s, x) => s + (x[j] - mean[j]) ** 2, 0) / n) || 1);
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));
  const pos = y.reduce((a, b) => a + b, 0), wPos = n / (2 * pos), wNeg = n / (2 * (n - pos));
  let w = new Array(d).fill(0), b = 0;
  for (let it = 0; it < 500; it++) {
    const g = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(Z[i].reduce((s, v, j) => s + v * w[j], b)), e = (p - y[i]) * (y[i] ? wPos : wNeg);
      for (let j = 0; j < d; j++) g[j] += e * Z[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= 0.2 * (g[j] / n + 0.05 * w[j]);
    b -= 0.2 * (gb / n);
  }
  return { w, b, mean, std, samples: n, bad: pos };
}

export function predict(model, f) {
  const x = vec(f), contrib = x.map((v, j) => model.w[j] * ((v - model.mean[j]) / model.std[j]));
  return { p: sigmoid(contrib.reduce((s, c) => s + c, model.b)), contrib };
}

// 0 to 1. Content problems found by the checker, plus recent sender trouble.
export function priorRisk(items, recentComplaintRate = 0) {
  const pen = items.reduce((n, i) => n + (i.level === 'fail' ? 20 : i.level === 'warn' ? 7 : 0), 0);
  return Math.min(1, pen / 60 + (recentComplaintRate >= 0.001 ? 0.2 : 0));
}

export const MIN_SAMPLES = 8;
export const usable = (m) => m && m.samples >= MIN_SAMPLES && m.bad >= 2 && m.samples - m.bad >= 2;

export async function assess(workspace, { subject, html, preview }) {
  const items = analyze({ subject, preview, html, workspace }).filter((i) => i.level === 'fail' || i.level === 'warn');
  const complaints = await recentRates(workspace.id);
  const prior = priorRisk(items, complaints.complaint_rate);
  const f = features({ subject, html });
  const row = await one(`SELECT weights FROM spam_models WHERE workspace_id = $1`, [workspace.id]);
  const model = row?.weights;
  let risk = prior, learned = null, learnedWeight = 0;
  const reasons = items.slice(0, 6).map((i) => ({ level: i.level, title: i.title, detail: i.detail || '' }));
  if (usable(model)) {
    const { p, contrib } = predict(model, f);
    learned = p; learnedWeight = Math.min(0.8, model.samples / 40);
    risk = (1 - learnedWeight) * prior + learnedWeight * p;
    // What past sends say about this kind of email, in plain words.
    FEATURES.map((k, j) => ({ k, c: contrib[j] })).filter((x) => x.c > 0.4 && f[x.k] > 0).sort((a, b) => b.c - a.c).slice(0, 3)
      .forEach((x) => reasons.push({ level: 'learned', title: REASON[x.k], detail: 'Past emails like this from you had more complaints, bounces or low opens.' }));
  }
  if (complaints.complaint_rate >= 0.001) reasons.push({ level: 'warn', title: 'Your recent emails got complaints', detail: `${(complaints.complaint_rate * 100).toFixed(2)}% of the last 30 days of sends were marked as spam.` });
  return { risk: Math.round(risk * 100), prior: Math.round(prior * 100), learned: learned === null ? null : Math.round(learned * 100), learned_weight: Math.round(learnedWeight * 100), samples: model?.samples || 0, reasons };
}

async function recentRates(workspaceId) {
  const r = await one(
    `SELECT count(*) FILTER (WHERE sent_at IS NOT NULL)::float AS sent, count(*) FILTER (WHERE complained_at IS NOT NULL)::float AS complained
     FROM messages WHERE workspace_id = $1 AND sent_at > now() - interval '30 days'`, [workspaceId]);
  return { complaint_rate: r.sent >= 100 ? r.complained / r.sent : 0 };
}

/* ---------- learning from what happened ---------- */
export const isBad = ({ sent, complaint_rate, bounce_rate, open_rate }, medianOpen) =>
  sent >= 30 && (complaint_rate >= 0.001 || bounce_rate >= 0.05 || (medianOpen >= 0.08 && open_rate < medianOpen * 0.35));

// Records the outcome of finished campaigns (two days after they finish, so opens and complaints have arrived)
// and retrains each workspace whose history grew. Safe to run on every server at once.
export async function learn() {
  const done = await many(
    `SELECT c.id, c.workspace_id, c.subject, c.html, c.risk_override_at,
            count(m.id) FILTER (WHERE m.sent_at IS NOT NULL)::float AS sent,
            count(m.id) FILTER (WHERE m.complained_at IS NOT NULL)::float AS complained,
            count(m.id) FILTER (WHERE m.bounced_at IS NOT NULL AND m.bounce_type = 'Permanent')::float AS bounced,
            count(m.id) FILTER (WHERE m.opened_at IS NOT NULL)::float AS opened
     FROM campaigns c JOIN messages m ON m.campaign_id = c.id
     WHERE c.status = 'sent' AND c.finished_at < now() - interval '2 days'
       AND NOT EXISTS (SELECT 1 FROM campaign_outcomes o WHERE o.campaign_id = c.id)
     GROUP BY c.id HAVING count(m.id) FILTER (WHERE m.sent_at IS NOT NULL) >= 30 LIMIT 200`);
  const touched = new Set();
  for (const c of done) {
    const med = await one(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY open_rate) AS m FROM campaign_outcomes WHERE workspace_id = $1`, [c.workspace_id]);
    const o = { sent: c.sent, complaint_rate: c.complained / c.sent, bounce_rate: c.bounced / c.sent, open_rate: c.opened / c.sent };
    const bad = isBad(o, Number(med?.m) || 0);
    await query(
      `INSERT INTO campaign_outcomes (campaign_id, workspace_id, features, sent, complaint_rate, bounce_rate, open_rate, bad, overridden)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [c.id, c.workspace_id, JSON.stringify(features(c)), c.sent, o.complaint_rate, o.bounce_rate, o.open_rate, bad, !!c.risk_override_at]);
    touched.add(c.workspace_id);
  }
  for (const wid of touched) await retrain(wid);
  return { learned: done.length, retrained: touched.size };
}

export async function retrain(workspaceId) {
  const rows = await many(`SELECT features, bad FROM campaign_outcomes WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 500`, [workspaceId]);
  const model = rows.length ? train(rows) : null;
  if (!usable(model)) return null;
  await query(
    `INSERT INTO spam_models (workspace_id, weights, samples, trained_at) VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (workspace_id) DO UPDATE SET weights = EXCLUDED.weights, samples = EXCLUDED.samples, trained_at = now()`,
    [workspaceId, JSON.stringify(model), model.samples]);
  return model;
}
