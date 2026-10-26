-- Reading replies and bounces from the sending mailboxes, and stopping outreach when someone answers.
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_host TEXT;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS watch_replies BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_uidvalidity BIGINT;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_last_uid BIGINT;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_checked_at TIMESTAMPTZ;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_error TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS replies (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mailbox_id INT REFERENCES mailboxes(id) ON DELETE SET NULL,
  contact_id INT REFERENCES contacts(id) ON DELETE SET NULL,
  message_id INT,
  kind TEXT NOT NULL,
  from_email TEXT NOT NULL,
  subject TEXT,
  snippet TEXT,
  header_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, header_id)
);
CREATE INDEX IF NOT EXISTS idx_replies_ws ON replies (workspace_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_replies_contact ON replies (contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_provider_id ON messages (provider_id) WHERE provider_id IS NOT NULL;
ALTER TABLE replies ENABLE ROW LEVEL SECURITY;
