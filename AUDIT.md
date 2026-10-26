# Wynmail production-readiness audit

Checked against the "what a vibe-coded app still needs" list. Status: **DONE** already in the code, **ADDED** in this pass, **PARTIAL** works with a known limit, **GAP** not built, **N/A** Wynmail has no such feature, **ORG** people or process, not code.

## Identity and access
| Item | Status | Notes |
|---|---|---|
| Schema someone designed | PARTIAL | Tenant column on every table, FKs, unique keys. Baseline is `schema.sql`; everything new goes in `migrations/`. Roles are free text, not an enum. |
| Login with a plus sign in the email | DONE | `+` is accepted and kept. Apostrophes in the local part (`o'brien@x.com`) are refused by `EMAIL_RE`: GAP, low. |
| Reset links expire, work once | DONE | 1 hour, hashed, single use, old links killed on use. Invites 72 hours. |
| MFA and recovery | ADDED | TOTP (authenticator app), codes can't be replayed, 10 single-use recovery codes, lockout after 10 wrong codes, re-auth to turn off. Lost phone and codes: admin `reset-mfa`. |
| Sessions time out, kill all for one user | ADDED | `SESSION_HOURS` (default 7d). `POST /api/auth/logout-all`. Admin `POST /api/admin/users/:id/revoke-sessions`. Password change and reset already did it. |
| SSO, SAML, SCIM | ADDED, OFF | Switched off until a customer needs it: `ENABLE_SSO=1` (server) and `VITE_ENABLE_SSO=1` (web). Details: | SAML 2.0 (signed assertions only, request IDs kept in Postgres, replay and tampering refused), per-workspace domains, optional enforce; SCIM 2.0 Users create/read/patch/delete with revocable tokens. Only Wyntek admins can edit SSO settings. IdP-initiated login is not supported. |
| Roles deeper than admin/everyone | ADDED | 14 per-feature permissions, role defaults (owner, member, viewer), per-person overrides. Every route is checked centrally; a new route is closed until listed in `perms.js`. |
| User A cannot read user B's data by changing a number | DONE | Every query carries `workspace_id`; foreign ids are checked (`ownsList`, `ownsSegment`). Covered by `test:security`, `test:api`, `test:media`. |
| Tenant isolation | DONE | App-level scoping plus RLS on every table. No Postgres RLS policies for the app role: one missed `WHERE` leaks. Acceptable now, review before the 3rd engineer. |
| Admin "log in as this user" with audit | N/A | No impersonation exists. Platform admin is a member of each client workspace, and admin actions are now audited. |
| Login rate limits | DONE | Per IP and per IP+email, in memory. Resets on restart, per instance: PARTIAL. |
| Lockout that spares the CFO | ADDED | 20 failures in 15 min (database counted) refuse only addresses that have not signed in to that account in 30 days. |

## Database
| Item | Status | Notes |
|---|---|---|
| Migrations forward and back | ADDED | `migrations/NNNN_name.up.sql` / `.down.sql`, `schema_migrations`, advisory lock. `npm run migrate`, `migrate:down`, `migrate:status`. CI runs up, down, up. |
| Migrations that do not lock tables | ADDED | `-- no-transaction` files run statement by statement; indexes use `CONCURRENTLY`. Rule for future ones in RUNBOOK. |
| Indexes | ADDED | 9 indexes on events, messages, contacts, campaigns, list_contacts, resets, api_keys. |
| Connection pooling | PARTIAL | Pool max 5, connect and idle timeouts, 30s statement timeout added. Use the Supabase pooler URL (README). |
| Nightly backups, tested restore, PITR | ORG | Supabase does backups; PITR is a paid add-on: **turn it on**. `scripts/restore-drill.sh` proves a restore. Run it quarterly. |
| Soft deletes | PARTIAL | Lists, templates and contacts: 30-day undo. `?permanent=1` or "Erase now" (owner) erases at once for privacy requests. A restored contact keeps tags and list membership but not past email history. Campaigns, forms, segments, automations: GAP. |
| Server-side validation | DONE | Everywhere inspected: zod/regex/length caps on every route. |
| Timezones | DONE | Stored UTC, per-contact and per-workspace zones, local-time sends. |
| Apostrophes, emoji, accents, RTL | DONE | Names accept all; merge output is HTML-escaped. Email local-part apostrophe: see above. |
| Money, currency, tax | N/A | No billing in Wynmail. |
| Data model survives "one small change" | PARTIAL | `attributes` JSONB and tags absorb most. |
| Idempotency keys | ADDED | `Idempotency-Key` on `POST /v1/emails`: replay, 422 on changed body, 409 while in flight. Concurrent clicks send once (tested). |
| Deduplication for four submits | DONE | Contacts unique per workspace; forms rate limited; automations enrol once. |
| Pagination on page 400 | ADDED | Contacts: `?cursor=` with `X-Next-Cursor`. Messages and exports are still capped (500 / 50k / 100k): PARTIAL. |
| Exports, imports | DONE | CSV export (formula-safe), import with BOM, `;`, quotes, duplicates, 5000 row cap. |
| Retention rules | ADDED | Hourly job: expired resets, idempotency keys, undo records, audit log (400d), optional `EVENTS_RETENTION_DAYS`. Per-contract retention: GAP. |

## Security
| Item | Status | Notes |
|---|---|---|
| Secrets out of code, rotate leaked keys | PARTIAL | No secrets found in the repo. `.env` ignored. **Rotate anything ever pasted into an AI chat.** `ENCRYPTION_KEY` defaults to `JWT_SECRET`: set it separately so rotating one does not lose the other. |
| Packages exist and are the ones meant | DONE | 9 server deps, all well-known; `npm audit` clean on the server. |
| Dependency scanning | ADDED | Web had 2 high Vite advisories: fixed by `npm audit fix`. CI runs `npm audit`; Dependabot monthly. |
| Input sanitisation, SQLi, XSS, CSRF | DONE | Parameterised SQL everywhere (segment compiler checked). Bearer tokens, so no CSRF. CSP on public forms. Builder output sanitised. |
| File uploads | DONE | Byte sniffing, SVG refused, 3 MB cap, `nosniff`. No malware scan: GAP, low (images only). |
| CORS not "allow everything" | DONE | `FRONTEND_URL` allow list. |
| Security headers | DONE / ADDED | helmet on API. Web: nosniff, frame deny, no-referrer (reset tokens), HSTS added in `vercel.json`. No CSP on the SPA: GAP. |
| Encryption at rest and in transit | PARTIAL | TLS to DB. Default does not verify the DB certificate: set `PG_SSL_CA` (a warning now prints). Provider keys AES-256-GCM. |
| Least privilege | PARTIAL | Secrets and keys now owner-only. Tell any AI agent: no production credentials. |
| Logs without secrets | ADDED | One JSON line per request with id, method, path template, status, ms. No headers, bodies or query strings. Audit meta redacts secret-looking keys. |
| Audit trails | ADDED | `audit_log`: sign-ins, failures, resets, sessions, settings fields, keys, members, deletes, restores, exports, admin actions. Owner reads `GET /audit`. Views of records: GAP (not needed until HIPAA). |
| Pen test, questionnaire, SOC 2, HIPAA, BAA, PCI, GDPR beyond deletion, data residency, access reviews | ORG | Not code. Do not store patient data. Card data never touches Wynmail. Contact delete erases signups and consent; backups age out. |
| Disclosure process | ADDED | `/.well-known/security.txt` from `SECURITY_CONTACT`. Set it. |
| Stolen laptop plan | ORG | RUNBOOK has the rotation list. |

## Infrastructure and delivery
| Item | Status | Notes |
|---|---|---|
| dev / staging / prod, IaC | PARTIAL | `render.yaml` is the IaC for the API. No staging service: add a second Render service from the same file. |
| Pipeline runs tests first | ADDED | `.github/workflows/ci.yml`: audit, unit, migration round trip, 8 integration suites, web build. Turn on "require CI" in GitHub. |
| One-click rollback | PARTIAL | Render and Vercel redeploy a previous build. Schema rollback: `migrate:down`. |
| Zero-downtime deploys | ADDED | Graceful SIGTERM (finish requests, stop worker, close pool), readiness health check on Render. **Needs a paid Render plan; free sleeps and pauses the queue.** |
| Feature flags, autoscaling, second region | GAP / ORG | Not needed at this size. |
| CDN, DNS, SSL | DONE | Vercel and Render. Put a calendar reminder on domain renewal. |
| Job queue, retries, dead letter | DONE / PARTIAL | `SKIP LOCKED` queue, 3 attempts, stuck-claim recovery. Failed messages stay `failed` with the error (that is the dead-letter list). No backoff delay between attempts: GAP, small. |
| Cron not running twice | DONE | Claims use `SKIP LOCKED`; housekeeping is idempotent. |
| Caching | N/A | Pictures are cache-immutable by token. |
| SPF, DKIM, DMARC, bounces, complaints | DONE | Domain checker, Svix-verified webhooks, suppressions. |
| Storage rules | PARTIAL | Pictures capped at 100 MB per workspace in Postgres; retention job added. |
| Cost alerts | ORG | Set billing alerts in Render, Supabase, Resend. Per-workspace daily send caps already bound spend. |
| Disaster recovery plan | ADDED | RUNBOOK.md. Test it once a year. |
| Structured logs, error tracking, uptime, alerts, dashboards, tracing, on-call, runbooks, postmortems, status page | PARTIAL / ORG | Logs structured now. Point an uptime monitor at `/health/ready`. Add Sentry when ready. Rest is process. |

## Testing
| Item | Status | Notes |
|---|---|---|
| Unit, integration, end-to-end | PARTIAL | 20 suites, now run in CI. No browser end-to-end for signup and send. |
| Regression, load, old laptops | GAP | Add a load run of the queue before a large launch. |
| Test data without production data | DONE | PGlite fresh database per suite. |

## Billing, API, AI
| Item | Status | Notes |
|---|---|---|
| Subscriptions, tax, invoices, refunds, metering | N/A | Wyntek bills outside Wynmail. |
| Inbound webhooks verify signatures | DONE | Svix HMAC, 5 minute window, timing-safe. |
| Outbound webhooks | N/A | Not built. |
| Versioned API, keys create/revoke, rate limits | DONE | `/v1`, hashed keys shown once, 120/min per key. Keys now owner-only. |
| Third-party format change, OAuth refresh, sandbox | PARTIAL / N/A | Provider interface isolates Resend. No OAuth. Sandbox: use the `console` provider. |
| Prompt injection, model spend, evals, fallbacks | N/A | Wynmail has no AI features. |

## Product and code health
| Item | Status | Notes |
|---|---|---|
| Hotel wifi, empty/loading/error states, actionable errors | PARTIAL | Errors are plain-language across the API. Not audited screen by screen. |
| Accessibility, translations, undo | GAP / PARTIAL | Builder has undo. No a11y or i18n pass. |
| Readable code, review, branching | PARTIAL | Code is readable. `routes/workspace.js` is ~900 lines: split by area next. |
| Dependency upgrades | ADDED | Dependabot monthly. |
| Dead code, architecture decisions, README | PARTIAL | README current. Add ADRs when decisions are made. |
| Admin panel, support tooling | PARTIAL | Clients page; activity log API is there, no UI yet. |
| Accounts in the company's name, bus factor | ORG | Check GitHub, Render, Vercel, Supabase, Resend, domain registrar are all under Wyntek. |

## Replies and outreach rules
IMAP access uses the mailbox's own app password, read-only, over TLS with the certificate checked, to a public server only (same address pinning as SMTP). Messages are fetched capped at 250 KB, parsed once, and stored only as a 300-character snippet plus sender, subject and date. The 3-email cap, the 48-hour gap and the stop-on-reply rule live in the send path (`queue.js`), not in the screens, so nothing that queues mail to a prospect can skip them. A removal request in a reply is honoured automatically.

## Prospector upgrades
Business search uses OpenStreetMap's public Overpass servers: typed text is validated (letters only, fixed lists for type and country) before it goes in a query, requests identify Wynmail, are capped in size and time, and are limited per workspace per day. Nothing is scraped from Google or social networks. Address guessing is not offered on purpose.

## SMTP mailboxes (added at your request)
Server address pinned to a public IP at connect time (no DNS tricks into the private network), port allow-list, certificate verified, STARTTLS required, 30s timeouts. Caps are claimed atomically in the database, so two servers cannot overspend. Auth failures switch a mailbox off. Gap: no bounce or complaint feed from SMTP, so the spam guard's live pause and the learning see only opens, clicks and immediate rejections.

## Prospector (added at your request)
Built to a "polite crawler" standard: robots.txt, 2 to 3 second pauses, same-site only, no private addresses (SSRF-guarded fetcher), size and time caps, daily and per-job limits, one search per workspace at a time, audit-logged. Judgement calls it makes for you: free inboxes (Gmail, Yahoo) are collected when the business prints them; no EU addresses by domain ending (a .com business in the EU still gets through), no one who ever unsubscribed or bounced. Legal duties stay with the sender: honest sender name, a working opt-out, your business address, and honouring opt-outs fast. Check the rules for the countries you email.

## Spam-risk guard (added at your request)
A campaign is scored before it sends: the content checker's rules, blended with a model trained on this workspace's own past campaigns (complaints, hard bounces, opens far below normal). Above the threshold it is held, not sent; the owner gets an in-app notification and an email, and chooses Fix it or Send anyway (logged). While a campaign is sending, a complaint rate of 0.5% or hard bounces of 10% pause the unsent rest and notify the owner. Nothing can see the spam folder, so this is an estimate that improves with use; it needs about 8 sent campaigns, including some that did badly, before the model has a say.

## Do these next (in order)
1. Turn on Supabase PITR; set `PG_SSL_CA`, `ENCRYPTION_KEY`, `SECURITY_CONTACT`; move Render off free.
2. Rotate every key that has ever been in an AI chat (Resend, DB password, JWT secret).
3. Run `scripts/restore-drill.sh` once.
4. Turn on required CI in GitHub.
5. Everyone with access to production turns on MFA, starting with you.
6. Before a customer relies on SSO: test with their IdP in a staging workspace, and keep one owner account on a password (break glass).
