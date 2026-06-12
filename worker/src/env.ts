// Worker secrets — set via `wrangler secret put` (prod) or .dev.vars (local).
export interface Env {
  KOOFR_EMAIL: string;
  KOOFR_APP_PASSWORD: string;
  DASHBOARD_TOKEN: string;
  /** Comma-separated CORS allowlist (var in wrangler.jsonc). localhost is always allowed. */
  ALLOWED_ORIGINS?: string;
}
