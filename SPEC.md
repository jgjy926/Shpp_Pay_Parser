# ShopeePay BNPL Tracker — Technical Scope

**Goal:** Zero-cost online dashboard to track ShopeePay BNPL / Instalment / Bill Payment transactions. Single user. Built and maintained via Claude Code.

---

## 1. Architecture Overview

```
┌─────────────┐     HTTPS      ┌────────────────────┐    WebDAV     ┌─────────┐
│   Browser    │ ─────────────▶ │ Cloudflare Worker  │ ────────────▶ │  Koofr  │
│  Dashboard   │   (Bearer      │  (API + auth +     │  (app pwd     │  JSON   │
│ (CF Pages)   │    token)      │   Koofr proxy)     │   secret)     │  files  │
└─────────────┘                └────────────────────┘               └─────────┘
        ▲
        │ auto-deploy on push
┌─────────────┐
│   GitHub     │  (repo + Actions CI/CD)
└─────────────┘
```

| Layer | Service | Free tier limits | Role |
|---|---|---|---|
| Frontend | Cloudflare Pages | Unlimited static requests | Dashboard SPA (vanilla JS or lightweight framework) |
| API | Cloudflare Worker | 100k req/day | Auth, CRUD, Koofr proxy |
| Storage | Koofr (WebDAV) | 10 GB free | Source of truth — JSON files |
| Repo/CI | GitHub + Actions | 2,000 min/month | Code, deploy Worker via Wrangler |

**Why Worker in the middle:** the browser must never see the Koofr password. The Worker holds it as a secret and exposes a small authenticated API instead.

---

## 2. Data Design

### Storage layout on Koofr
```
/shopeepay-tracker/
  transactions/2026-05.json     ← one file per month
  transactions/2026-06.json
  meta.json                     ← list of months, last sync, schema version
```

Monthly sharding keeps files small (<50 KB), makes reads fast, and avoids rewriting one giant file on every import.

### Transaction schema
```json
{
  "id": "sha1(date|type|desc|amount)",
  "date": "2026-05-29",
  "type": "BNPL | Instalment | Bill Payment | Refund",
  "description": "In Store - THONG 1964 ENTERPRISE",
  "merchant": "THONG 1964 ENTERPRISE",
  "channel": "in_store | online",
  "sign": "+",
  "amount": 10.00,
  "currency": "MYR",
  "importedAt": "2026-06-12T08:00:00Z"
}
```

- `id` is deterministic → dedupe on re-import is automatic.
- `merchant` extracted from `In Store - X` pattern; online product purchases get `channel: online`.

### Concurrency
Single user, low write volume. Strategy: read file → merge → write with WebDAV `If-Match` ETag. On 412 conflict, re-read and retry once. Last-write-wins is acceptable.

---

## 3. Cloudflare Worker — API Spec

**Auth:** `Authorization: Bearer <DASHBOARD_TOKEN>` on every request. Token + Koofr credentials stored as Worker secrets (`wrangler secret put`). CORS locked to the Pages domain.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/months` | List available months (from meta.json) |
| GET | `/api/transactions?month=2026-05` | Fetch one month |
| POST | `/api/transactions` | Bulk upsert (array). Worker shards by month, dedupes by id, returns `{added, skipped}` |
| DELETE | `/api/transactions/:id?month=` | Remove one record |
| GET | `/api/summary?month=` | Server-computed totals: charges, payments, refunds, net, top merchants |
| GET | `/api/export` | Full dump (all months) as JSON — backup |

**Secrets:** `KOOFR_EMAIL`, `KOOFR_APP_PASSWORD` (generate an app-specific password in Koofr settings — never the main password), `DASHBOARD_TOKEN`.

**Koofr WebDAV endpoint:** `https://app.koofr.net/dav/Koofr/<path>` with Basic auth.

---

## 4. Frontend Scope (Cloudflare Pages)

Single-page app, mobile-first (primary use is phone). No build step needed — vanilla JS + CSS, or Vite if Claude Code prefers.

**Views (bottom tab bar):**
1. **Dashboard** — month selector; cards for total charges (BNPL + Instalment), payments made, net owed; top-merchant bar chart; type breakdown; multi-month trend line.
2. **Transactions** — list with filters (type, month, merchant search), swipe/tap to delete.
3. **Add** —
   - *Paste mode:* textarea → client-side parser → preview table → confirm import (POST bulk).
   - *Manual form:* type, description, date, amount.
4. **Settings** — API token entry (stored in memory/session), export backup button.

**Parser (client-side):** handles the ShopeePay copy-paste format —
```
<Type line: BNPL|Instalment|Bill Payment|Refund>
<optional description line(s)>
<DD Mon YYYY>
<+/- RM9,999.99>
```
Regex-based state machine; tolerant of blank lines; handles `RM1,132.32` comma format. Unit tests with the May 2026 dataset (60+ records) as fixture.

---

## 5. Repo Structure

```
shopeepay-tracker/
├── worker/
│   ├── src/index.ts          # Hono or raw Worker
│   ├── src/koofr.ts          # WebDAV client (fetch-based)
│   └── wrangler.toml
├── web/
│   ├── index.html
│   ├── app.js  /  parser.js  /  api.js
│   └── styles.css
├── tests/
│   ├── parser.test.js        # fixture: may-2026.txt
│   └── worker.test.ts
├── .github/workflows/deploy.yml   # wrangler deploy on push to main
├── SPEC.md                   # this file
└── CLAUDE.md                 # Claude Code instructions
```

---

## 6. Build Phases (for Claude Code)

1. **Phase 0 — Scaffold:** repo, wrangler.toml, Pages project, CI workflow. *Acceptance: hello-world Worker + blank page deployed.*
2. **Phase 1 — Koofr client:** WebDAV read/write/ETag module + secrets. *Acceptance: Worker can round-trip a test JSON file.*
3. **Phase 2 — API:** all endpoints + auth + CORS + dedupe logic. *Acceptance: curl tests pass.*
4. **Phase 3 — Parser:** client-side parser + unit tests against May fixture. *Acceptance: 100% of May records parsed correctly.*
5. **Phase 4 — Frontend:** all four views wired to API, mobile-first. *Acceptance: paste May data → dashboard shows correct totals.*
6. **Phase 5 — Polish:** charts, trend view, export backup, error states, retry-on-conflict.

---

## 7. Risks & Mitigations

- **Koofr WebDAV latency (~300–800 ms/op):** fine at this volume; optionally cache reads in Worker memory per request. Avoid Cloudflare KV unless needed (KV free writes capped at 1k/day — sufficient anyway, but Koofr is source of truth per requirement).
- **Token in browser:** single-user Bearer token entered once in Settings, kept in sessionStorage on your own device. Acceptable for personal use; can upgrade to Cloudflare Access later (also free for ≤50 users).
- **ShopeePay format changes:** parser is isolated in one module with fixture tests — cheap to update.
- **Backup:** `/api/export` + Koofr's own versioning give two recovery paths.

---

## 8. Out of Scope (v1)

Multi-user accounts, automatic scraping of ShopeePay (no public API; manual paste only), instalment payment-schedule prediction (possible v2), currency other than MYR.
