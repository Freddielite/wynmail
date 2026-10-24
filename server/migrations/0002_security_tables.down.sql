DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS deleted_records;
DROP TABLE IF EXISTS audit_log;
ALTER TABLE users DROP COLUMN IF EXISTS sessions_valid_after;
