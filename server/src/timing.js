import { many, query } from './db.js';
import { modeHour, nextAtHour, wallToInstant, validTz, MIN_OPENS } from './timeutil.js';

const JITTER = () => Number(process.env.BESTTIME_JITTER_MIN ?? 50);

// Gives every message in a campaign the moment it may leave: the hour its person usually opens email in.
// People with fewer than three opens get the hour most of the workspace opens in. If there is no history
// at all, everyone goes straight away. Automatic opens by privacy proxies are left out.
export async function applyBestTime(campaign, now = new Date()) {
  const wsRows = await many(
    `SELECT extract(hour from created_at at time zone 'UTC')::int AS h FROM events
     WHERE workspace_id = $1 AND type = 'open' AND coalesce(meta->>'proxy', 'false') <> 'true'
       AND created_at > now() - interval '180 days' LIMIT 100000`, [campaign.workspace_id]);
  const wsHour = wsRows.length >= 20 ? modeHour(wsRows.map((r) => r.h)) : null;

  const rows = await many(
    `SELECT m.contact_id, extract(hour from e.created_at at time zone 'UTC')::int AS h
     FROM events e JOIN messages m ON m.id = e.message_id
     WHERE e.workspace_id = $1 AND e.type = 'open' AND coalesce(e.meta->>'proxy', 'false') <> 'true'
       AND e.created_at > now() - interval '180 days'
       AND m.contact_id IN (SELECT contact_id FROM messages WHERE campaign_id = $2)
     LIMIT 500000`, [campaign.workspace_id, campaign.id]);
  const hours = new Map();
  for (const r of rows) { if (!hours.has(r.contact_id)) hours.set(r.contact_id, []); hours.get(r.contact_id).push(r.h); }

  const targets = await many(`SELECT contact_id FROM messages WHERE campaign_id = $1`, [campaign.id]);
  const ids = [], times = [];
  let personal = 0;
  for (const { contact_id: id } of targets) {
    const own = (hours.get(id) || []).length >= MIN_OPENS ? modeHour(hours.get(id)) : null;
    const hour = own ?? wsHour;
    if (hour === null) continue;
    if (own !== null) personal += 1;
    ids.push(id); times.push(nextAtHour(hour, now, JITTER()).toISOString());
  }
  if (ids.length) {
    await query(
      `UPDATE messages SET send_after = u.t FROM unnest($2::int[], $3::timestamptz[]) AS u(cid, t)
       WHERE messages.campaign_id = $1 AND messages.contact_id = u.cid`, [campaign.id, ids, times]);
  }
  return { timed: ids.length, personal, workspace_hour: wsHour };
}

// Everyone gets the chosen wall clock time in their own zone. People with no zone on file use the workspace zone.
export async function applyLocalTime(campaign, defaultTz) {
  const fallback = validTz(defaultTz) ? defaultTz : 'UTC';
  const zones = await many(
    `SELECT DISTINCT coalesce(c.timezone, $2) AS tz FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.campaign_id = $1`,
    [campaign.id, fallback]);
  let timed = 0;
  for (const { tz } of zones) {
    const at = wallToInstant(campaign.local_at, validTz(tz) ? tz : fallback);
    if (!at) continue;
    const r = await query(
      `UPDATE messages SET send_after = $3 FROM contacts c
       WHERE messages.campaign_id = $1 AND c.id = messages.contact_id AND coalesce(c.timezone, $2) = $4`,
      [campaign.id, fallback, at.toISOString(), tz]);
    timed += r.rowCount ?? r.affectedRows ?? 0;
  }
  return { timed, zones: zones.length };
}
