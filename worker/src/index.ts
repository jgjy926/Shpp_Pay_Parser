// ShopeePay BNPL Tracker — API Worker
// Phase 0: hello-world. API routes land in Phase 2 (see SPEC.md §3).

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "shopeepay-tracker", phase: 0 });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler;
