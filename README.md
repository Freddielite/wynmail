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

## API

Create a key on the API page in the app (shown once, revocable, several per workspace). Send it as `Authorization: Bearer wm_...`.

- `POST /v1/emails` sends one transactional email. No unsubscribe footer, no link tracking. Body: `to`, `subject`, `html` or `text` or `template_id`, optional `variables`, `reply_to`.
- `POST /v1/contacts` adds or updates a contact. Body: `email`, `first_name`, `last_name`, `attributes`, and `list` (name, created if missing) or `list_ids`. Unsubscribed contacts stay unsubscribed.
- `GET /v1/contacts/{email}` and `POST /v1/contacts/{email}/unsubscribe`
- `GET /v1/lists`, `GET /v1/campaigns`, `GET /v1/campaigns/{id}`

Limits: 120 requests a minute per key. API emails count toward the workspace daily limit and need an approved sending domain. All provider calls share one throttle (`SEND_GAP_MS`, default 500) so the provider's rate limit is respected.

Tests inside `server`: `npm run test:csv` needs nothing. `test:security`, `test:api`, `test:batch`, `test:forms`, `test:automations`, `test:quickwins`, `test:designs`, `test:media`, `test:analytics` and `test:segments` each run against a fresh empty database with `FORCE_PROVIDER=console`. `test:automations` also needs `AUTOMATION_MINUTE_MS=1000` on the server. `test:builder`, `test:csv` and `test:domain` need nothing. `test:analytics` needs `JWT_SECRET` set (it signs tracked links the same way the server does). `test:quickwins`, `test:batch` and `test:forms` also need `RESEND_WEBHOOK_SECRET` set on the server and `LOG` pointing at the server log file.

## Email builder

Templates, campaigns and every automation email have a **Visual** tab and an **HTML** tab.

- The visual builder works with blocks: heading, text, image, button, two columns, divider, spacer, social links and custom HTML. Drag blocks from the palette (or click them), drag to reorder, drag into a column, and edit each block in the side panel. Undo and redo cover every change, and Delete removes the selected block.
- A gallery of designs (Welcome, Newsletter, Promotion, Announcement, Simple letter, Blank) plus your own saved templates is the starting point. Email-wide style (background, width, font, colors) lives in the same panel when no block is selected.
- Preview and Phone views show the email with sample names filled in.
- The design is stored as JSON next to the email-safe HTML it renders to (tables and inline styles, no scripts). Only the HTML is ever sent, so an email keeps working if the builder changes. Text, colors, sizes and links are sanitised before they reach the HTML.
- Every designed email has a locked footer block. The `{{footer}}` token places the address and unsubscribe link inside the design, and plain HTML emails still get the footer at the end.
- Editing the HTML tab by hand disconnects the visual design. Pictures are added by web address for now.
- The renderer is pure JavaScript in `web/src/builder/render.js`, so the tests import it directly.

## Everyday tools

- **Unblock:** the workspace owner can unblock a bounced or spam-complaint address from Contacts (status filter, or the Blocked addresses card). People who reported spam need an extra confirmation. Unsubscribed people cannot be unblocked this way, they must confirm a signup form.
- **Domain check** in Settings looks up DKIM, SPF, the bounce MX, DMARC and the tracking domain, and says what to fix. Lookups run in parallel and never block for more than about 4 seconds.
- **Duplicate** a campaign from the campaign list. **Preview text** is the line inboxes show after the subject, set per campaign and per automation email.
- **Name fallbacks:** `{{first_name|there}}` uses "there" when the value is empty. Works in subjects, previews, campaigns, automations and API emails.
- **CSV export** for contacts (with lists, consent details and merge fields) and per-campaign reports. Cells that look like spreadsheet formulas are neutralised.

## Automations

An automation sends a sequence of emails to people after they join a list, for example a welcome email now and a follow-up in 3 days.

- The trigger is joining a list, however it happens: a signup form (after confirming), the API, or adding a contact by hand. People added by CSV import are skipped unless the automation opts in, and turning an automation on never emails people who are already on the list.
- Each person enters an automation once, ever. Rejoining the list does not restart it.
- Each email has its own delay, counted from the previous email (or from joining, for the first). Delays can be minutes, hours or days.
- A sequence stops for anyone who unsubscribes, bounces or complains before their next email. Pausing an automation holds every send and stops new enrollments, and resuming continues where people left off.
- Automation emails go through the normal sending queue, so the rate limit, daily cap, open and click tracking, unsubscribe footer, bounce handling and reports all apply. Editing an automation changes what people who have not yet reached that email will receive.
- Turning one on needs the same sender setup as sending a campaign.
- The People panel shows where everyone is in the sequence.
- `AUTOMATION_MINUTE_MS` (default 60000) is a test knob that shortens how long a minute of delay lasts. Leave it unset in production.

## Signup forms

The Forms page creates public signup forms that feed a list. Each form has a hosted page (`/f/<slug>` on your API or tracking domain), an iframe embed with auto-resize, and a plain HTML snippet for custom designs.

- Double opt-in is on by default. A signup is only "pending" until the person clicks the link in the confirmation email. Opening the link only shows a button, so mail scanners cannot confirm anyone. Links work once and expire after 48 hours.
- Every confirmed contact keeps a consent record: the exact sentence they agreed to, the time, the form and the IP address. Deleting a contact also deletes their signup log.
- Someone who unsubscribed can only come back by confirming, even on a single opt-in form. Addresses that bounced or complained are silently ignored.
- Abuse protection: a hidden honeypot field, a signed timing token, per-IP and per-address rate limits, and the same success answer whether or not the address is already known.
- Confirmation emails send from the workspace's approved sender and count toward the daily limit. Failed confirmation emails show their reason in the Signups panel.
- Embeds need an https or http page. Browsers do not treat `file://` or `about:blank` pages as valid embedders.

## Pictures

Every workspace has its own picture library, uploaded straight into the database (no external storage needed). PNG, JPEG, GIF and WEBP only, up to 3 MB each and 100 MB total per workspace. Files are checked by their actual bytes, not just the label, and SVG is refused since it can carry scripts. Pictures are served from `/m/<token>` with a far-future cache header. Deleting a picture that is used in a saved template, campaign or automation email warns first, since it would break the picture there and in any copy of the email already sent.

The email builder's Image block opens this library, or you can still paste a picture's own web address.

## Analytics

The Analytics page shows sent, open rate, click rate, bounce rate and unsubscribe rate for a chosen period, a daily chart, a heatmap of when people open by day and hour (in the reader's own time zone), and a table comparing recent campaigns.

Each campaign's Report has its own analytics: a funnel from sent to delivered to opened to clicked, an hourly timeline, which links got clicked and by how many people, and a breakdown by device (phone, computer, tablet). Bots and security scanners are filtered out: link scanners that open every email the moment it arrives do not count as opens, and a click within 5 seconds of sending does not count as a click, though the visitor is still sent on to the page either way.

## Segments and contact profiles

Segments are saved rules that are worked out fresh every time they are used, so they never go stale. Rules can match on status, list membership, tags, name, email, custom fields, when they joined, and behavior (opened or clicked in the last N days, never opened, or received, opened, clicked or didn't open a specific campaign). Match all or any of up to 10 rules. A live count updates as you build one.

A campaign can send to a list or a segment. When it sends, the segment is worked out again at that moment, so it always reflects who matches right then, and only subscribed contacts ever receive it.

Every contact has a profile page (click their email from Contacts): details, tags and custom fields you can edit, which lists they are on, their full email history with outcomes, their signup and automation history, and their consent record (source, time, the exact sentence they agreed to, and the IP address, when known).

Tags are plain words on a contact, settable by hand, through CSV import (a `tags` column, split on `;` or `|`), or through the API.

## Bounces and spam complaints

Resend tells Wynmail when an email is delivered, bounces or is reported as spam.

1. In Resend open Webhooks, add an endpoint `https://<your-render-url>/webhooks/resend` with the events `email.delivered`, `email.bounced` and `email.complained`.
2. Copy its signing secret into `RESEND_WEBHOOK_SECRET` on Render.

What happens: permanent bounces and spam complaints mark the contact `bounced` or `complained` and block them from every later campaign, import, API contact and API email. Temporary bounces (full mailbox) are recorded but do not block. Reports and the dashboard show the counts.

A client with their own Resend account adds a webhook to `https://<your-render-url>/webhooks/resend/<workspace id>` and pastes its signing secret in Settings. Webhooks are verified with the Svix signature and rejected if older than 5 minutes.

## Passwords, invites and test emails

- Password reset and team invites are emailed from `SYSTEM_FROM` through the shared Resend key. Until you have a verified domain, the default `onboarding@resend.dev` only reaches the Resend account owner, so share the invite link shown on the Team page instead.
- Changing or resetting a password signs out every other session.
- Send test to me on the campaign editor sends the draft to the signed-in user. It only goes to members of the workspace and counts toward the daily limit.

## Security model

- Signup is closed after the first account. That account becomes the admin (set `ADMIN_EMAIL` so only you can claim it). Admins create client workspaces on the Clients page.
- Only admins can change a workspace's sending domain, daily limit, per-minute rate and provider. Clients can only send from an admin-approved domain, which stops one client spoofing another through the shared provider key.
- Wynmail API keys are stored only as SHA-256 hashes and shown once. Revoking takes effect immediately.
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
