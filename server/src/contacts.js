import { many, one, query } from './db.js';
import { enroll } from './automations.js';
import { normEmail, cleanName, cleanAttrs } from './validate.js';

// Existing unsubscribed contacts stay unsubscribed. Only names and attributes are updated.
export async function upsertContact(workspaceId, body, listId, opts = {}) {
  const attrs = cleanAttrs(body.attributes);
  const contact = await one(
    `INSERT INTO contacts (workspace_id, email, first_name, last_name, attributes, consent_source, consent_at, status)
     VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), $6, now(),
       COALESCE((SELECT CASE s.reason WHEN 'complained' THEN 'complained' ELSE 'bounced' END
                 FROM suppressions s WHERE s.workspace_id = $1 AND s.email = $2), 'subscribed'))
     ON CONFLICT (workspace_id, email) DO UPDATE SET
       first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
       last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
       attributes = contacts.attributes || EXCLUDED.attributes
     RETURNING *`,
    [workspaceId, normEmail(body.email), cleanName(body.first_name) || null, cleanName(body.last_name) || null,
     attrs ? JSON.stringify(attrs) : null, body.consent_source || 'manual']
  );
  if (listId) await attachLists(workspaceId, contact.id, [listId], opts);
  return contact;
}

// Only lists that belong to the workspace are attached. Newly added memberships start automations.
export async function attachLists(workspaceId, contactId, listIds, { source = 'manual' } = {}) {
  if (!listIds.length) return;
  const added = await many(
    `INSERT INTO list_contacts (list_id, contact_id)
     SELECT l.id, $2 FROM lists l WHERE l.workspace_id = $3 AND l.id = ANY($1::int[]) ON CONFLICT DO NOTHING RETURNING list_id`,
    [listIds, contactId, workspaceId]
  );
  if (added.length) await enroll(workspaceId, contactId, added.map((r) => r.list_id), source);
}
