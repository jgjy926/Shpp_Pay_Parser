// ShopeePay BNPL Tracker — API Worker
// Phase 1: Koofr WebDAV client + round-trip test route. Full API lands in Phase 2 (SPEC.md §3).

import { KoofrClient, KoofrConflictError } from "./koofr";
import type { Env } from "./env";

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.DASHBOARD_TOKEN) return false;
  return request.headers.get("Authorization") === `Bearer ${env.DASHBOARD_TOKEN}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "shopeepay-tracker", phase: 1 });
    }

    // Phase 1 acceptance check: write → read → conditional re-write → stale-write rejected.
    // Removed once the real API exists (Phase 2).
    if (url.pathname === "/api/debug/roundtrip") {
      if (!isAuthorized(request, env)) return unauthorized();

      const koofr = new KoofrClient(env.KOOFR_EMAIL, env.KOOFR_APP_PASSWORD);
      const path = "debug/roundtrip-test.json";
      const payload = { hello: "koofr", at: new Date().toISOString() };

      await koofr.putJson(path, payload);
      const first = await koofr.getJson<typeof payload>(path);
      if (!first) return Response.json({ ok: false, step: "read-after-write" }, { status: 500 });

      // Conditional write with the fresh ETag must succeed…
      await koofr.putJson(path, { ...payload, rev: 2 }, first.etag);
      const second = await koofr.getJson<typeof payload>(path);

      // …and a write with the now-stale ETag must 412.
      let staleRejected = false;
      try {
        await koofr.putJson(path, { ...payload, rev: 3 }, first.etag);
      } catch (e) {
        staleRejected = e instanceof KoofrConflictError;
      }

      return Response.json({
        ok: first.data.at === payload.at && staleRejected,
        wrote: payload,
        readBack: first.data,
        etagFlow: { firstEtag: first.etag, secondEtag: second?.etag, staleRejected },
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
