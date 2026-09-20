import { one, query } from './db.js';
import { normEmail, cleanName, cleanAttrs } from './validate.js';

// Existing unsubscribed contacts stay unsubscribed. Only names and attributes are updated.
export async function upsertContact(workspaceId, body, listId) {
  const attrs = cleanAttrs(body.attributes);
  const contact = await one(
    `INSERT INTO contacts (workspace_id, email, first_name, last_name, attributes, consent_source, consent_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), $6, now())
     ON CONFLICT (workspace_id, email) DO UPDATE SET
       first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
       last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
       attributes = contacts.attributes || EXCLUDED.attributes
     RETURNING *`,
    [workspaceId, normEmail(body.email), cleanName(body.first_name) || null, cleanName(body.last_name) || null,
     attrs ? JSON.stringify(attrs) : null, body.consent_source || 'manual']
  );
  if (listId) await attachLists(workspaceId, contact.id, [listId]);
  return contact;
}

// Only lists that belong to the workspace are attached.
export async function attachLists(workspaceId, contactId, listIds) {
  if (!listIds.length) return;
  await query(
    `INSERT INTO list_contacts (list_id, contact_id)
     SELECT l.id, $2 FROM lists l WHERE l.workspace_id = $3 AND l.id = ANY($1::int[]) ON CONFLICT DO NOTHING`,
    [listIds, contactId, workspaceId]
  );
}
