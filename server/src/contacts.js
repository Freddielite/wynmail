import { many, one, query } from './db.js';
import { enroll } from './automations.js';
import { normEmail, cleanName, cleanAttrs, cleanTags } from './validate.js';

// Existing unsubscribed contacts stay unsubscribed. Only names and attributes are updated.
export async function upsertContact(workspaceId, body, listId, opts = {}) {
  const attrs = cleanAttrs(body.attributes);
  const contact = await one(
    `INSERT INTO contacts (workspace_id, email, first_name, last_name, attributes, consent_source, consent_at, tags, status)
     VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), $6, now(), $7::text[],
       COALESCE((SELECT CASE s.reason WHEN 'complained' THEN 'complained' ELSE 'bounced' END
                 FROM suppressions s WHERE s.workspace_id = $1 AND s.email = $2), 'subscribed'))
     ON CONFLICT (workspace_id, email) DO UPDATE SET
       first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
       last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
       attributes = contacts.attributes || EXCLUDED.attributes,
       tags = ARRAY(SELECT DISTINCT unnest(contacts.tags || EXCLUDED.tags))
     RETURNING *`,
    [workspaceId, normEmail(body.email), cleanName(body.first_name) || null, cleanName(body.last_name) || null,
     attrs ? JSON.stringify(attrs) : null, body.consent_source || 'manual', cleanTags(body.tags)]
  );
  if (listId) await attachLists(workspaceId, contact.id, [listId], opts);
  return contact;
}

// Only lists that belong to the workspace are attached. Newly added memberships start automations.
// Someone who left a list on their preference page is not added back by imports, the API or hand.
// Only their own confirmed signup (source "form") or their own preference page (source "prefs") brings them back.
export async function attachLists(workspaceId, contactId, listIds, { source = 'manual' } = {}) {
  if (!listIds.length) return { blocked: 0 };
  if (source === 'form' || source === 'prefs') {
    await query(`DELETE FROM list_optouts WHERE contact_id = $1 AND list_id = ANY($2::int[])`, [contactId, listIds]);
  }
  const added = await many(
    `INSERT INTO list_contacts (list_id, contact_id)
     SELECT l.id, $2 FROM lists l WHERE l.workspace_id = $3 AND l.id = ANY($1::int[])
       AND NOT EXISTS (SELECT 1 FROM list_optouts o WHERE o.contact_id = $2 AND o.list_id = l.id)
     ON CONFLICT DO NOTHING RETURNING list_id`,
    [listIds, contactId, workspaceId]
  );
  const blocked = (await one(`SELECT count(*)::int AS n FROM list_optouts WHERE contact_id = $1 AND list_id = ANY($2::int[])`, [contactId, listIds])).n;
  if (added.length) await enroll(workspaceId, contactId, added.map((r) => r.list_id), source === 'prefs' ? 'manual' : source);
  return { blocked };
}
