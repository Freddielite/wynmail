-- Prospector: businesses found by category and city, richer lead details, and how many addresses to keep per company.
ALTER TABLE prospect_jobs ADD COLUMN IF NOT EXISTS per_company INT NOT NULL DEFAULT 2;
ALTER TABLE prospect_sites ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE prospect_sites ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE prospect_sites ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE prospect_sites ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE prospect_sites ADD COLUMN IF NOT EXISTS listed_email TEXT;
ALTER TABLE prospect_sites ADD COLUMN IF NOT EXISTS listed_page TEXT;
ALTER TABLE prospect_sites ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'website';
ALTER TABLE prospect_results ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE prospect_results ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE prospect_results ADD COLUMN IF NOT EXISTS score INT;
ALTER TABLE prospect_results ADD COLUMN IF NOT EXISTS phone TEXT;
