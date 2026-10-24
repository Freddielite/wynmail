# Wynmail runbook

## Health
- `/health` process is up. `/health/ready` database answers. Monitor the second from outside (UptimeRobot or similar), alert by SMS.
- Every response has `X-Request-Id`; the same id is in the log line. Ask users for it.

## Deploy and roll back
- Push to main: CI must pass, Render and Vercel deploy. Render sends SIGTERM; the server finishes requests and exits cleanly.
- Bad deploy: Render > Deploys > redeploy the previous one; Vercel > Deployments > promote the previous one.
- Bad migration: `cd server && DATABASE_URL=... npm run migrate:down` (one step), then redeploy the previous build.

## Writing a migration that is safe at 2pm on a Tuesday
- New file pair in `server/migrations/`: `0003_name.up.sql` and `0003_name.down.sql`. Never edit one that has shipped.
- Add a column as nullable or with a constant default; backfill in batches in a later migration; add NOT NULL last.
- Indexes: first line `-- no-transaction`, then `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...`, one statement per `;`.
- No table rewrites, no `ALTER TYPE`, no FK validation on a big table in one go (`NOT VALID`, then `VALIDATE`).

## Restore
1. Supabase > Database > Backups: restore into a new project (or PITR to a minute before the mistake).
2. Point `DATABASE_URL` at it, redeploy, check `/health/ready`.
3. Accidental delete of a list or template within 30 days: `POST /api/workspaces/:id/deleted/:recordId/restore`.
4. Drill: `SOURCE_URL=... SCRATCH_URL=... server/scripts/restore-drill.sh` quarterly.

## Lost sessions or a compromised account
- One person: admin calls `POST /api/admin/users/:id/revoke-sessions`, then sends a password reset.
- Everyone: change `JWT_SECRET` on Render. All sessions end. Provider keys become unreadable unless `ENCRYPTION_KEY` is set separately, so set that first and never change it without re-saving keys.

## Stolen laptop or leaked key
Rotate in this order: Supabase DB password, `JWT_SECRET`, Resend API key and webhook secret, Render and Vercel tokens, GitHub tokens and SSH keys. Revoke the user's sessions in each dashboard. Check `audit_log` for the window.

## Vulnerability report
Mail arrives at `SECURITY_CONTACT`. Acknowledge in 2 working days, fix, deploy, tell the reporter. Write a short postmortem: what happened, what changed so it cannot repeat.

## Alerts you will see
- `housekeeping failed`: a clean-up query errored, check DB health, harmless short term.
- `audit write failed`: audit table or DB trouble; requests still work.
- `idle pg client error`: DB restarted or dropped a connection; the pool recovers.
- Queue stuck: messages `sending` for over 10 minutes are re-queued automatically.

## Two-step sign-in: someone lost their phone
1. They use a recovery code on the sign-in screen ("I lost my phone").
2. No codes either: confirm who they are outside the app (call a known number), then `POST /api/admin/users/:id/reset-mfa` as a platform admin. It switches MFA off and signs them out everywhere. They set it up again.

## Onboarding an enterprise customer on SSO
0. SSO is off by default. Set `ENABLE_SSO=1` on Render and `VITE_ENABLE_SSO=1` on Vercel, then redeploy both.
1. Set `PUBLIC_URL` on the API to its https address.
2. Give their IT team the three values from Team > Single sign-on: Entity ID, Reply URL (ACS), SCIM base URL.
3. They send back the sign-in URL, entity ID and signing certificate. As a platform admin: `PUT /api/workspaces/:id/sso` with `idp_sso_url`, `idp_entity_id`, `idp_cert`, `domains` (only domains the customer owns), `enabled: true`.
4. Mint a SCIM token (`POST /api/workspaces/:id/scim-tokens`), give it to their IT team once.
5. Test with one person before `enforce: true`. Platform admins and the workspace owner can still use a password after enforcing.
6. Offboarding: IT deactivates the person in their identity provider, SCIM removes the membership, and access ends on the next request.

## Held or paused campaigns
- Held (`needs_review`): open the campaign, read the reasons, fix it or send it anyway. Raise the threshold in Settings if it holds good email.
- Paused: complaints or bounces spiked mid-send. Check the list source and the email, then Resume or leave it stopped.
