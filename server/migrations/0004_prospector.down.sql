DROP TABLE IF EXISTS prospect_results;
DROP TABLE IF EXISTS prospect_sites;
DROP TABLE IF EXISTS prospect_jobs;
ALTER TABLE contacts DROP COLUMN IF EXISTS source_found_at;
ALTER TABLE contacts DROP COLUMN IF EXISTS source_url;
ALTER TABLE lists DROP COLUMN IF EXISTS kind;
