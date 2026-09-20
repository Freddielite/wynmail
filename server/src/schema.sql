CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  sending_domain TEXT,
  from_name TEXT,
  from_email TEXT,
  reply_to TEXT,
  tracking_domain TEXT,
  footer_address TEXT,
  rate_per_minute INT NOT NULL DEFAULT 60,
  daily_limit INT NOT NULL DEFAULT 1000,
  provider TEXT NOT NULL DEFAULT 'resend',
  provider_api_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS lists (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'subscribed',
  consent_source TEXT,
  consent_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);

CREATE TABLE IF NOT EXISTS list_contacts (
  list_id INT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id INT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE IF NOT EXISTS templates (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  list_id INT REFERENCES lists(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id INT REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INT REFERENCES contacts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  provider_id TEXT,
  error TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  open_count INT NOT NULL DEFAULT 0,
  click_count INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL,
  message_id INT REFERENCES messages(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  url TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages (status, queued_at);
CREATE INDEX IF NOT EXISTS idx_messages_campaign ON messages (campaign_id);
CREATE INDEX IF NOT EXISTS idx_contacts_workspace ON contacts (workspace_id, status);

-- Supabase exposes every public table through its Data API. This app talks to
-- Postgres directly as the table owner, so lock the tables down for the API roles.
-- RLS enabled with no policies means anon and authenticated roles get nothing.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_emails (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  api_key_id INT REFERENCES api_keys(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sending',
  provider_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_emails_ws ON api_emails (workspace_id, created_at DESC);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_emails ENABLE ROW LEVEL SECURITY;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS bounce_type TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS complained_at TIMESTAMPTZ;
ALTER TABLE api_emails ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'api';
ALTER TABLE api_emails ADD COLUMN IF NOT EXISTS provider_id TEXT;
ALTER TABLE api_emails ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

CREATE TABLE IF NOT EXISTS suppressions (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages (provider_id);
CREATE INDEX IF NOT EXISTS idx_api_emails_provider ON api_emails (provider_id);
ALTER TABLE suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;

-- Repair rows saved with the literal text "null" as the tracking domain.
UPDATE workspaces SET tracking_domain = '' WHERE lower(tracking_domain) = 'null';

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_text TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_ip TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_form_id INT;

CREATE TABLE IF NOT EXISTS forms (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  list_id INT REFERENCES lists(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Subscribe',
  description TEXT NOT NULL DEFAULT '',
  button_label TEXT NOT NULL DEFAULT 'Subscribe',
  ask_names BOOLEAN NOT NULL DEFAULT true,
  consent_text TEXT NOT NULL DEFAULT 'I agree to receive emails and understand I can unsubscribe at any time.',
  double_optin BOOLEAN NOT NULL DEFAULT true,
  success_message TEXT NOT NULL DEFAULT 'Thanks! Check your inbox to confirm your subscription.',
  redirect_url TEXT NOT NULL DEFAULT '',
  confirm_subject TEXT NOT NULL DEFAULT 'Confirm your subscription',
  confirm_body TEXT NOT NULL DEFAULT 'Please confirm your email address to finish subscribing.',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per signup attempt: a pending confirmation, a confirmed subscriber, or an expired link.
CREATE TABLE IF NOT EXISTS form_signups (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  form_id INT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  token_hash TEXT UNIQUE,
  consent_text TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  email_status TEXT NOT NULL DEFAULT 'none',
  email_error TEXT,
  expires_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_form_signups_form ON form_signups (form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_signups_email ON form_signups (workspace_id, email);
ALTER TABLE forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_signups ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS automations (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  list_id INT REFERENCES lists(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'paused',
  include_imports BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_steps (
  id SERIAL PRIMARY KEY,
  automation_id INT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  position INT NOT NULL,
  delay_minutes INT NOT NULL DEFAULT 0,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  UNIQUE (automation_id, position)
);

-- One row per person per automation. A person is enrolled once, ever.
CREATE TABLE IF NOT EXISTS automation_runs (
  id SERIAL PRIMARY KEY,
  automation_id INT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id INT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  current_step INT NOT NULL DEFAULT 0,
  next_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (automation_id, contact_id)
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS automation_id INT REFERENCES automations(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS step_id INT REFERENCES automation_steps(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS run_id INT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_run_step ON messages (run_id, step_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_due ON automation_runs (status, next_at);
CREATE INDEX IF NOT EXISTS idx_messages_automation ON messages (automation_id);
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;
