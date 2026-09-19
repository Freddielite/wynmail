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
