-- Prospector: finds business emails on company websites. Keeps prospects apart from people who signed up.
ALTER TABLE lists ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_found_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS prospect_jobs (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by INT,
  status TEXT NOT NULL DEFAULT 'queued',
  total_sites INT NOT NULL DEFAULT 0,
  done_sites INT NOT NULL DEFAULT 0,
  found INT NOT NULL DEFAULT 0,
  saved INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_prospect_jobs_ws ON prospect_jobs (workspace_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_prospect_jobs_status ON prospect_jobs (status, id);

CREATE TABLE IF NOT EXISTS prospect_sites (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES prospect_jobs(id) ON DELETE CASCADE,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  pages_checked INT NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE (job_id, url)
);
CREATE INDEX IF NOT EXISTS idx_prospect_sites_job ON prospect_sites (job_id, id);

CREATE TABLE IF NOT EXISTS prospect_results (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES prospect_jobs(id) ON DELETE CASCADE,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  site_url TEXT NOT NULL,
  page_url TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  contact_id INT,
  found_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, email)
);
CREATE INDEX IF NOT EXISTS idx_prospect_results_job ON prospect_results (job_id, id);

ALTER TABLE prospect_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_results ENABLE ROW LEVEL SECURITY;
