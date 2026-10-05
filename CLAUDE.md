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
- `npx wrangler pages deploy web --project-name shpp-tracker` — manual Pages deploy

## Rules
- Secrets (`KOOFR_EMAIL`, `KOOFR_APP_PASSWORD`, `DASHBOARD_TOKEN`) only via `wrangler secret put` / `.dev.vars` (gitignored). Never in code or config.
- Koofr (WebDAV) is the source of truth for data — do not introduce KV/D1 as primary storage.
- Transaction `id` is deterministic sha1(date|type|desc|amount); dedupe relies on it.
- Currency is MYR only (v1). Single user — keep auth as one Bearer token.

## Build status
- [x] Phase 0 — scaffold (hello-world Worker + blank page)
- [x] Phase 1 — Koofr WebDAV client (note: Koofr ignores If-Match on PUT; client pre-checks with HEAD)
- [x] Phase 2 — API endpoints + auth + CORS
- [x] Phase 3 — client-side parser + fixture tests (58/58 real May 2026 records parse clean)
  - Parser auto-detects two ShopeePay layouts: per-record (type+date+amount each) and the newer
    grouped monthly statement (type as a section header, no per-item date, unsigned amounts). Grouped
    items inherit the statement month (anchored to its last day) derived from the period/due-date
    header; sign defaults by type (Refund +, else −). Genuine same-merchant/same-amount repeats are kept distinct via a
    per-occurrence id suffix in `worker/src/store.ts` (occurrence 0 keeps the bare id — dedupe stays
    backward compatible). Fixture: `tests/fixtures/aug-2026-grouped.txt` (83 records, cross-checked
    against the statement's own Bill Amount RM2,501.49).
- [x] Phase 6/7 — bill ↔ history merge, separate stores (SPEC.md §2 "Bill items vs history")
  - Separate stores + panels (Phase 7): bill items → `transactions/YYYY-MM.json` (Add ▸ Bill,
    `/api/transactions`, requires `statement`); transaction history incl. repayments and manual
    entries → `history/YYYY-MM.json` (Add ▸ Transactions, `/api/history`, forbids `statement`).
    meta.json tracks `months` (bill) and `historyMonths`. A paste may contain both; each panel keeps
    only its own kind and says how many rows belong in the other panel.
  - Yearless "paid in full" bills (no Due Date line) borrow the year from dated rows in the paste,
    else the latest non-future year. The parser cross-checks the statement's Bill Amount.
  - `web/reconcile.js` is pure and shared: the browser uses it for previews (against stored
    records fetched from the API), and the Worker imports it (`../../web/reconcile.js`, `allowJs`)
    to reconcile bill + history shards over a ±12-month window on every import/delete, writing
    `txnDate`/`ref` into bill items and `billedIn` into history. Bill item ids still use the
    statement's last day, so enrichment never changes an id.
  - Summary: month with a bill = bill total; without = the month's history purchases (estimate).
    `pending` = history purchases not yet on any bill; `payments` = repayments from history.
  - `POST /api/migrate[?dryRun=1]` (Settings ▸ Check older data) splits pre-Phase-7 data: untagged
    rows in bill shards move to history/, except grouped-statement rows (month's last day, ≥5 in one
    import batch) which get tagged as bill items.
  - Fixtures: `tests/fixtures/sep-2026-bill.txt` (paid-in-full, 44 items = RM1,209.98) and
    `sep-2026-history.txt` (25 records). No Worker test harness yet; Store was verified by bundling
    with esbuild and running against an in-memory fake Koofr (both import orders + migration).
- [x] Phase 4 — frontend views
- [x] Phase 5 — polish (trend chart, cached loads, error/retry states, PWA manifest)
