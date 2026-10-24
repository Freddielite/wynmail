-- Spam-risk learning, notifications, per-feature permissions, MFA, SSO and SCIM.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS risk_hold_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS risk_threshold INT NOT NULL DEFAULT 60;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS risk_score INT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS risk_reasons JSONB;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS risk_override_at TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS risk_override_by INT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS paused_reason TEXT;

CREATE TABLE IF NOT EXISTS campaign_outcomes (
  campaign_id INT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  features JSONB NOT NULL,
  sent INT NOT NULL,
  complaint_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  bounce_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  unsub_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  open_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  bad BOOLEAN NOT NULL,
  overridden BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outcomes_ws ON campaign_outcomes (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS spam_models (
  workspace_id INT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  weights JSONB NOT NULL,
  samples INT NOT NULL,
  trained_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  campaign_id INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notifications_ws ON notifications (workspace_id, id DESC);

ALTER TABLE memberships ADD COLUMN IF NOT EXISTS permissions TEXT[];
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS provisioned_by TEXT;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS scim_external_id TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_codes_user ON mfa_recovery_codes (user_id);

CREATE TABLE IF NOT EXISTS sso_configs (
  workspace_id INT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  idp_entity_id TEXT NOT NULL DEFAULT '',
  idp_sso_url TEXT NOT NULL DEFAULT '',
  idp_cert TEXT NOT NULL DEFAULT '',
  domains TEXT[] NOT NULL DEFAULT '{}',
  enforce BOOLEAN NOT NULL DEFAULT false,
  default_role TEXT NOT NULL DEFAULT 'member',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS scim_tokens (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

-- Sign-in requests we started, so a SAML response must answer one of them (works across servers).
CREATE TABLE IF NOT EXISTS saml_requests (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE saml_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE campaign_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE spam_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_tokens ENABLE ROW LEVEL SECURITY;
