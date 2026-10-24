import { query, many } from './db.js';
import { sendSystemEmail, actionEmail } from './sysmail.js';
import { frontendBase } from './resets.js';

// A notification shows in the app and is emailed to the workspace owners.
export async function notify(workspaceId, { kind, title, body = '', campaignId = null, path = '/campaigns' }) {
  await query(`INSERT INTO notifications (workspace_id, kind, title, body, campaign_id) VALUES ($1, $2, $3, $4, $5)`,
    [workspaceId, kind, String(title).slice(0, 200), String(body).slice(0, 2000), campaignId]);
  try {
    const owners = await many(`SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.role = 'owner'`, [workspaceId]);
    const url = `${frontendBase()}${path}`;
    const mail = actionEmail({ heading: title, body, label: 'Review it', url, note: 'You are getting this because you own this Wynmail workspace.' });
    for (const o of owners) await sendSystemEmail({ to: o.email, subject: title, html: mail.html, text: `${title}\n\n${body}\n\n${url}` });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'notification email failed', err: err.message }));
  }
}
