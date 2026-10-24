-- Session kill switch, audit trail, undo window for deletes, idempotency keys.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_after TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT,
  actor_user_id INT,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_log (workspace_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_target ON audit_log (action, target, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_ip ON audit_log (actor_user_id, action, ip);

CREATE TABLE IF NOT EXISTS deleted_records (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT,
  data JSONB NOT NULL,
  deleted_by INT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deleted_ws ON deleted_records (workspace_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_deleted_purge ON deleted_records (purge_after);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INT,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE deleted_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
