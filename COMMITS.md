# Suggested commit sequence

1. `chore: scaffold Wynmail monorepo (Express API + React/Vite web)`
2. `feat(db): add multi-tenant schema for workspaces, contacts, lists, templates, campaigns, messages, events`
3. `feat(auth): JWT auth with per-workspace membership guards`
4. `feat(providers): pluggable sending provider interface with Resend and console drivers`
5. `feat(render): merge fields, tracked link rewriting, compliance footer and one-click unsubscribe headers`
6. `feat(queue): sending worker with per-workspace rate limits, daily caps and retries`
7. `feat(api): contacts, CSV import, lists, templates and campaign endpoints`
8. `feat(tracking): open pixel, click redirect and unsubscribe confirmation page`
9. `feat(web): Wyntek-branded dashboard, contacts, templates, campaigns and settings`
10. `docs: add README, env examples and DNS checklist`
11. `feat(db): support Supabase Postgres with pooler connection, capped pool size and RLS lockdown on all tables`
12. `fix(security): close signup after first admin, admin-only limits and sending domain, block cross-tenant sender spoofing`
13. `fix(security): encrypt provider API keys at rest and stop returning them from the API`
14. `fix(security): sign tracking links to remove open redirect, require POST to unsubscribe`
15. `fix(security): HTML-escape merge values, sandbox previews, validate tracking domain, sender and inputs`
16. `fix(security): ownership checks on lists and campaigns, atomic campaign send and message claim to prevent double sends`
17. `fix(security): rate limit auth, pin JWT algorithm, require JWT_SECRET in production, helmet, scoped CORS, optional DB CA verification`
18. `test: add security regression suite`
19. `feat(web): admin Clients page and admin-aware Settings`
20. `chore(deploy): add Vercel SPA rewrite, Render blueprint and Node engine requirement`
21. `fix(queue): enforce per-minute limit per tick and add global send gap to respect provider rate limits`
22. `fix(api): ignore trailing slashes in FRONTEND_URL when matching CORS origins`
23. `feat(brand): add refined Globe mail logo, favicon and brand assets, use logo in sidebar and login`
24. `fix(web): make every page responsive, with a scrollable mobile nav, sign out and workspace switcher on phones, and card layouts for tables`
25. `fix(web): pin sidebar account and sign out section to the bottom of the panel and keep the sidebar fixed while scrolling`
26. `fix(queue): refuse to send campaigns whose list has no subscribed contacts and return them to draft`
27. `feat(api): add per-workspace API keys and public /v1 endpoints for contacts, single emails and campaign stats`
28. `feat(web): add API page with key management, curl examples and recent API sends`
29. `feat(web): add toasts, busy buttons and live campaign status, plus a one-button send flow and list picker`
30. `test: add API test suite and share one provider throttle between campaigns and API sends`
31. `fix(web): remove the tall gap in the mobile header, keep the current page centred in the scrollable menu, and stop buttons in form rows from being clipped`
32. `feat(web): fade the mobile menu edges as it scrolls, left fade grows from the first swipe and right fade clears at the end`
33. `feat(bounces): handle signed Resend webhooks for delivered, bounced and complained, and suppress bad addresses in campaigns, imports and the API`
34. `feat(web): show delivery outcomes in campaign reports, the dashboard and settings`
35. `feat(campaigns): add Send test to me in the campaign editor`
36. `feat(auth): add change password, emailed password reset and sign-out of old sessions when a password changes`
37. `feat(team): add workspace members with emailed invites and owner-only controls`
38. `fix(import): parse quoted CSV fields, semicolon and tab files, and report duplicates and row errors`
39. `test: add batch and CSV test suites`
40. `fix(settings): stop saving the text "null" as the tracking domain, repair existing rows, and fall back to the app URL for email links`
41. `fix(campaigns): show how many contacts in a list can actually receive, and why others are skipped`
42. `fix(campaigns): refuse to send or schedule a campaign with no content`
43. `feat(forms): add signup forms with hosted pages, embeds and a plain HTML option`
44. `feat(forms): add double opt-in confirmation by email with a scanner-safe confirm page and consent records`
45. `feat(forms): protect signups with honeypot, timing token, rate limits and uniform responses`
46. `feat(web): add Forms page with live preview, embed code and signup log`
47. `test: add signup forms test suite`
48. `feat(automations): add multi-step automations that start when someone joins a list, with delays, once-only enrollment and safe defaults for imports`
49. `feat(automations): send automation emails through the normal queue so limits, tracking, unsubscribe and bounce handling apply`
50. `feat(web): add Automations page with sequence builder, welcome email starter, live stats and people panel`
51. `feat(forms): start welcome sequences when a signup is confirmed`
52. `test: add automations test suite`
53. `feat(contacts): add Unblock for bounced and spam-complaint addresses, a status filter and a Blocked addresses list, owner only`
54. `feat(settings): add a domain checker for DKIM, SPF, bounce MX, DMARC and tracking domain, with parallel lookups`
55. `feat(campaigns): add Duplicate, preview text on campaigns and automation emails, and {{name|fallback}} merge fallbacks`
56. `feat(export): add spreadsheet-safe CSV export for contacts and campaign reports`
57. `fix(api): add the missing messages.unsubscribed_at column so /v1/campaigns works and unsubscribes are counted per campaign`
58. `test: add quick wins and domain checker test suites, and cover the campaign stats API`
