// API client — Bearer token from sessionStorage (SPEC.md §4 Settings).
// API base URL is not a secret, so it lives in localStorage.

export const cfg = {
  get apiBase() {
    return (localStorage.getItem("apiBase") || "http://localhost:8787").replace(/\/+$/, "");
  },
  set apiBase(v) {
    localStorage.setItem("apiBase", v.trim());
  },
  get token() {
    return sessionStorage.getItem("token") || "";
  },
  set token(v) {
    sessionStorage.setItem("token", v.trim());
  },
};

async function req(path, opts = {}) {
  let res;
  try {
    res = await fetch(cfg.apiBase + path, {
      ...opts,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch {
    throw new Error("Network error — check the API URL in Settings");
  }
  if (!res.ok) {
    let msg = "";
    try {
      msg = (await res.json()).error;
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401) msg = "Unauthorized — set your token in Settings";
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  health: () => req("/api/health"),
  months: () => req("/api/months"),
  transactions: (month) => req(`/api/transactions?month=${month}`),
  importTransactions: (txns) => req("/api/transactions", { method: "POST", body: JSON.stringify(txns) }),
  remove: (id, month) => req(`/api/transactions/${id}?month=${month}`, { method: "DELETE" }),
  summary: (month) => req(`/api/summary?month=${month}`),
  exportAll: () => req("/api/export"),
};
