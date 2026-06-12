// ShopeePay BNPL Tracker — API Worker (SPEC.md §3)
// Bearer-token auth on every /api route; CORS locked to the Pages origin (+ localhost for dev).

import { KoofrClient } from "./koofr";
import { Store } from "./store";
import { TX_TYPES, type IncomingTransaction, type TxType } from "./types";
import type { Env } from "./env";

const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!allowed.includes(origin) && !isLocal) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function validateIncoming(raw: unknown, index: number): IncomingTransaction {
  if (typeof raw !== "object" || raw === null) throw new ApiError(400, `item ${index}: not an object`);
  const t = raw as Record<string, unknown>;
  if (typeof t.date !== "string" || !DATE_RE.test(t.date))
    throw new ApiError(400, `item ${index}: date must be YYYY-MM-DD`);
  if (!TX_TYPES.includes(t.type as TxType))
    throw new ApiError(400, `item ${index}: type must be one of ${TX_TYPES.join(", ")}`);
  if (typeof t.description !== "string" || !t.description.trim())
    throw new ApiError(400, `item ${index}: description required`);
  if (t.sign !== "+" && t.sign !== "-") throw new ApiError(400, `item ${index}: sign must be + or -`);
  if (typeof t.amount !== "number" || !Number.isFinite(t.amount) || t.amount <= 0)
    throw new ApiError(400, `item ${index}: amount must be a positive number`);
  return {
    date: t.date,
    type: t.type as TxType,
    description: t.description,
    sign: t.sign,
    amount: t.amount,
    ...(typeof t.merchant === "string" && t.merchant.trim() ? { merchant: t.merchant } : {}),
    ...(t.channel === "in_store" || t.channel === "online" ? { channel: t.channel } : {}),
  };
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function requireMonth(url: URL): string {
  const month = url.searchParams.get("month");
  if (!month || !MONTH_RE.test(month)) throw new ApiError(400, "month=YYYY-MM query param required");
  return month;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === "/api/health") {
    return Response.json({ ok: true, service: "shopeepay-tracker", phase: 2 });
  }

  const token = env.DASHBOARD_TOKEN;
  if (!token || request.headers.get("Authorization") !== `Bearer ${token}`) {
    throw new ApiError(401, "Unauthorized");
  }

  const store = new Store(new KoofrClient(env.KOOFR_EMAIL, env.KOOFR_APP_PASSWORD));

  if (pathname === "/api/months" && request.method === "GET") {
    return Response.json(await store.getMeta());
  }

  if (pathname === "/api/transactions" && request.method === "GET") {
    return Response.json(await store.getMonth(requireMonth(url)));
  }

  if (pathname === "/api/transactions" && request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, "body must be JSON");
    }
    if (!Array.isArray(body)) throw new ApiError(400, "body must be an array of transactions");
    if (body.length === 0) return Response.json({ added: 0, skipped: 0 });
    if (body.length > 1000) throw new ApiError(400, "max 1000 transactions per request");
    const txns = body.map(validateIncoming);
    return Response.json(await store.upsert(txns));
  }

  const deleteMatch = pathname.match(/^\/api\/transactions\/([0-9a-f]{40})$/);
  if (deleteMatch && request.method === "DELETE") {
    const removed = await store.deleteTransaction(requireMonth(url), deleteMatch[1]);
    if (!removed) throw new ApiError(404, "transaction not found in that month");
    return Response.json({ deleted: true });
  }

  if (pathname === "/api/summary" && request.method === "GET") {
    return Response.json(await store.summary(requireMonth(url)));
  }

  if (pathname === "/api/export" && request.method === "GET") {
    return Response.json(await store.exportAll(), {
      headers: { "Content-Disposition": 'attachment; filename="shopeepay-tracker-export.json"' },
    });
  }

  throw new ApiError(404, "Not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    let response: Response;
    try {
      response = await route(request, env);
    } catch (e) {
      response =
        e instanceof ApiError
          ? Response.json({ error: e.message }, { status: e.status })
          : Response.json({ error: "Internal error" }, { status: 500 });
      if (!(e instanceof ApiError)) console.error(e);
    }

    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
  },
} satisfies ExportedHandler<Env>;
