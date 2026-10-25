-- SMTP mailboxes (Zoho Mail, Google Workspace...) a workspace sends through, each with its own daily cap.
CREATE TABLE IF NOT EXISTS mailboxes (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL,
  port INT NOT NULL,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  from_email TEXT NOT NULL,
  daily_cap INT NOT NULL DEFAULT 30,
  enabled BOOLEAN NOT NULL DEFAULT true,
  sent_day DATE,
  sent_today INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, from_email)
);
CREATE INDEX IF NOT EXISTS idx_mailboxes_ws ON mailboxes (workspace_id, enabled);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mailbox_id INT;
ALTER TABLE mailboxes ENABLE ROW LEVEL SECURITY;
