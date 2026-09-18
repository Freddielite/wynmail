# Wynmail

Email marketing platform by Wyntek Technologies. Multi-tenant, one workspace per client, Brevo-style.

## Stack

- `server` Node 22, Express, Postgres (`pg`), JWT auth
- `web` React 19 + Vite, Wyntek light theme (navy to blue gradient, blue highlights)
- Sending via a provider interface. Resend today, an in-house SMTP engine later.

## Run locally

Backend, no Postgres needed for a dry run:

```bash
cd server
npm install
USE_PGLITE=1 PGLITE_DIR=./.pgdata FORCE_PROVIDER=console npm start
```

With real Postgres and real sending, copy `.env.example` to `.env`, fill `DATABASE_URL` and `RESEND_API_KEY`, then `npm start`. The schema migrates itself on boot.

Frontend:

```bash
cd web
npm install
npm run dev
```

## What v1 does

- Workspaces, one per client, each with its own sender identity, tracking domain, provider key and limits
- Contacts with merge attributes, consent source and subscribe status, plus CSV import
- Lists
- Templates with live preview and `{{merge_field}}` syntax
- Campaigns: draft, schedule, send now, per-recipient report
- Queue worker with per-workspace emails-per-minute and daily caps, 3 retries per message
- Tracking: open pixel, click redirect, open and click counts per message
- Compliance: mandatory unsubscribe link, footer postal address, `List-Unsubscribe` and one-click POST unsubscribe

## Swapping the sending provider

Every provider implements one method:

```js
send({ to, from, replyTo, subject, html, text, headers, apiKey }) -> { id }
```

Add `server/src/providers/wynsmtp.js`, register it in `providers/index.js`, then set a workspace's `provider` field. Nothing else changes. Tracking already runs on your own domain, so it survives the swap.

## Database: Supabase

1. Create a Supabase project and set a database password.
2. Project Settings > Database > Connection string > Session pooler. Copy it into `DATABASE_URL`.
3. Start the server. The schema creates itself on boot, including row level security on every table.
4. Do not put the Supabase anon key in the frontend. Wynmail never uses the Supabase Data API, all access goes through the Express server.

Use the pooler host, not `db.<ref>.supabase.co`, which is IPv6 only on the free tier.

## Security model

- Signup is closed after the first account. That account becomes the admin (set `ADMIN_EMAIL` so only you can claim it). Admins create client workspaces on the Clients page.
- Only admins can change a workspace's sending domain, daily limit, per-minute rate and provider. Clients can only send from an admin-approved domain, which stops one client spoofing another through the shared provider key.
- Provider API keys are encrypted at rest (AES-256-GCM) and never returned by the API.
- Click links are HMAC signed, so the tracking domain cannot be used as an open redirect.
- Unsubscribe needs a confirmed POST. Link scanners that prefetch URLs cannot unsubscribe anyone.
- Merge values are HTML escaped. Campaign and template previews render in sandboxed iframes with scripts off.
- Every query is scoped to the caller's workspace and every foreign id (lists, campaigns, contacts) is ownership checked.
- Login and register are rate limited per IP and per account. Rate limits are in memory, per server instance.
- The server refuses to start in production without a strong `JWT_SECRET`.

Regression suite: start the server on an empty database with `FORCE_PROVIDER=console`, then run `npm run test:security` inside `server`.

Known limits: no password reset, email verification or 2FA yet, and the session token lives in browser localStorage.

## Deploy

Push the repo to GitHub, then:

1. Render: New Web Service, root directory `server`, build `npm install`, start `npm start`, health check `/health`. Or use `render.yaml` as a Blueprint. Set the environment variables listed in `server/.env.example`. Do not set `PORT`, Render provides it.
2. Vercel: import the repo, root directory `web`, framework Vite. Set `VITE_API_URL` to the Render URL, then redeploy. `web/vercel.json` handles page refreshes on client routes.
3. Set `FRONTEND_URL` on Render to the Vercel URL, with no trailing slash, then redeploy the API.
4. Open the Vercel site, create the account with `ADMIN_EMAIL`, then use Clients to add workspaces.

## Deployment notes

- Backend on Render, frontend on Vercel, database on Supabase.
- Point each client's `track.clientdomain.com` at the backend, and set it as the workspace tracking domain, so link reputation stays per client.
- Verify each sending domain with the provider and publish SPF, DKIM and DMARC. The Settings page shows the checklist.

## Not in v1

- Automations and drip sequences
- Bounce and complaint webhooks from the provider
- Drag-and-drop email builder
- Billing and plan limits
- Public signup forms
