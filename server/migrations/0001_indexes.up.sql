-- no-transaction
-- Indexes for the queries that are instant on 50 rows and slow on 5 million.
-- CONCURRENTLY so a big table is never locked for writes while an index builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_ws_created ON events (workspace_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_message ON events (message_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_ws_sent ON messages (workspace_id, sent_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_contact ON messages (contact_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_list_contacts_contact ON list_contacts (contact_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_password_resets_user ON password_resets (user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_api_keys_ws ON api_keys (workspace_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaigns_ws ON campaigns (workspace_id, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_ws_id ON contacts (workspace_id, id DESC);
