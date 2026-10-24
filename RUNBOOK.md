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
