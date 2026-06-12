# ShopeePay BNPL Tracker — Claude Code instructions

Read SPEC.md first — it is the source of truth for architecture, data design, API, and build phases.

## Layout
- `worker/` — Cloudflare Worker (TypeScript, raw fetch handler). Config in `worker/wrangler.jsonc` (JSONC preferred over TOML).
- `web/` — static SPA for Cloudflare Pages. No build step: vanilla JS + CSS, deployed as-is.
- `tests/` — parser fixture tests (Phase 3+).
- `.github/workflows/deploy.yml` — deploys Worker + Pages on push to main. Needs repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Commands
- `cd worker && npm run dev` — local dev server (http://localhost:8787)
- `cd worker && npm run deploy` — manual Worker deploy
- `cd worker && npm run types` — regenerate worker-configuration.d.ts after wrangler.jsonc changes
- `npx wrangler pages deploy web --project-name shopeepay-tracker` — manual Pages deploy

## Rules
- Secrets (`KOOFR_EMAIL`, `KOOFR_APP_PASSWORD`, `DASHBOARD_TOKEN`) only via `wrangler secret put` / `.dev.vars` (gitignored). Never in code or config.
- Koofr (WebDAV) is the source of truth for data — do not introduce KV/D1 as primary storage.
- Transaction `id` is deterministic sha1(date|type|desc|amount); dedupe relies on it.
- Currency is MYR only (v1). Single user — keep auth as one Bearer token.

## Build status
- [x] Phase 0 — scaffold (hello-world Worker + blank page)
- [ ] Phase 1 — Koofr WebDAV client
- [ ] Phase 2 — API endpoints + auth + CORS
- [ ] Phase 3 — client-side parser + fixture tests
- [ ] Phase 4 — frontend views
- [ ] Phase 5 — polish
