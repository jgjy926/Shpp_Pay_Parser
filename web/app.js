// ShopeePay BNPL Tracker SPA — four views on a bottom tab bar (SPEC.md §4).

import { api, cfg } from "./api.js";
import { parseShopeePay } from "./parser.js";

const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");

const fmtRM = (n) =>
  "RM " + n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const monthLabel = (m) => {
  const [y, mo] = m.split("-");
  return new Date(+y, +mo - 1, 1).toLocaleString("en-MY", { month: "short", year: "numeric" });
};

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = isError ? "show error" : "show";
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = ""), 3500);
}

// Cache API reads per page load; cleared whenever data changes.
const cache = { months: null, summary: new Map() };
function invalidate() {
  cache.months = null;
  cache.summary.clear();
}
async function loadSummary(month) {
  if (!cache.summary.has(month)) cache.summary.set(month, await api.summary(month));
  return cache.summary.get(month);
}

function monthSelector(months, selected, onChange) {
  const sel = document.createElement("select");
  sel.className = "month-select";
  sel.innerHTML = months
    .map((m) => `<option value="${m}" ${m === selected ? "selected" : ""}>${monthLabel(m)}</option>`)
    .join("");
  sel.onchange = () => onChange(sel.value);
  return sel;
}

async function loadMonths() {
  if (!cache.months) cache.months = (await api.months()).months;
  return cache.months;
}

// ---------- Dashboard ----------

async function renderDashboard() {
  view.innerHTML = `<div class="loading">Loading…</div>`;
  const months = await loadMonths();
  if (!months.length) {
    view.innerHTML = `<div class="empty">No data yet — import transactions from the <b>Add</b> tab.</div>`;
    return;
  }
  const month = state.month && months.includes(state.month) ? state.month : months[months.length - 1];
  state.month = month;
  const s = await loadSummary(month);

  const maxMerchant = Math.max(...s.topMerchants.map((m) => m.total), 1);
  view.innerHTML = `
    <div class="row" id="dash-head"></div>
    <div class="cards">
      <div class="card"><div class="card-label">Charges</div><div class="card-value">${fmtRM(s.charges)}</div><div class="card-sub">BNPL + Instalment</div></div>
      <div class="card"><div class="card-label">Payments</div><div class="card-value">${fmtRM(s.payments)}</div><div class="card-sub">Bill Payment</div></div>
      <div class="card accent"><div class="card-label">Net owed</div><div class="card-value">${fmtRM(s.net)}</div><div class="card-sub">${s.count} transactions${s.refunds ? ` · ${fmtRM(s.refunds)} refunded` : ""}</div></div>
    </div>
    <h2>By type</h2>
    <div class="type-grid">
      ${Object.entries(s.byType)
        .map(([t, v]) => `<div class="type-row"><span>${esc(t)} <small>×${v.count}</small></span><b>${fmtRM(v.total)}</b></div>`)
        .join("") || `<div class="empty">—</div>`}
    </div>
    <h2>Top merchants</h2>
    <div class="bars">
      ${s.topMerchants
        .map(
          (m) => `
        <div class="bar-row">
          <div class="bar-label" title="${esc(m.merchant)}">${esc(m.merchant)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(m.total / maxMerchant) * 100}%"></div></div>
          <div class="bar-value">${fmtRM(m.total)}</div>
        </div>`,
        )
        .join("") || `<div class="empty">No BNPL/Instalment spend this month.</div>`}
    </div>
    ${months.length >= 2 ? `<h2>Trend</h2><div id="trend" class="loading">Loading…</div>` : ""}`;
  $("#dash-head").append(monthSelector(months, month, (m) => ((state.month = m), renderDashboard())));
  if (months.length >= 2) renderTrend(months).catch((e) => ($("#trend").textContent = e.message));
}

async function renderTrend(months) {
  const recent = months.slice(-6);
  const sums = await Promise.all(recent.map(loadSummary));
  const el = $("#trend");
  if (!el) return; // user navigated away mid-fetch

  const W = 340, H = 150, base = H - 28, top = 14;
  const max = Math.max(...sums.flatMap((s) => [s.charges, s.payments]), 1);
  const slot = (W - 20) / recent.length;
  const x = (i) => 10 + (i + 0.5) * slot;
  const y = (v) => base - (v / max) * (base - top);
  const bw = Math.min(14, slot / 3);

  el.classList.remove("loading");
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="trend-svg" role="img" aria-label="Monthly charges vs payments">
      <line x1="10" y1="${base}" x2="${W - 10}" y2="${base}" class="axis" />
      ${sums
        .map((s, i) => {
          const label = new Date(s.month + "-01").toLocaleString("en-MY", { month: "short" });
          return `
        <rect x="${x(i) - bw - 1}" y="${y(s.charges)}" width="${bw}" height="${base - y(s.charges)}" class="bar-charges" rx="2" />
        <rect x="${x(i) + 1}" y="${y(s.payments)}" width="${bw}" height="${base - y(s.payments)}" class="bar-payments" rx="2" />
        <text x="${x(i)}" y="${H - 14}" class="trend-label">${label}</text>
        <text x="${x(i)}" y="${H - 3}" class="trend-net ${s.net > 0 ? "owe" : ""}">${s.net > 0 ? "+" : ""}${Math.round(s.net)}</text>`;
        })
        .join("")}
    </svg>
    <div class="trend-legend">
      <span><i class="sw sw-charges"></i>Charges</span>
      <span><i class="sw sw-payments"></i>Payments</span>
      <span>numbers = net (RM)</span>
    </div>`;
}

// ---------- Transactions ----------

async function renderTransactions() {
  view.innerHTML = `<div class="loading">Loading…</div>`;
  const months = await loadMonths();
  if (!months.length) {
    view.innerHTML = `<div class="empty">No data yet — import transactions from the <b>Add</b> tab.</div>`;
    return;
  }
  const month = state.month && months.includes(state.month) ? state.month : months[months.length - 1];
  state.month = month;
  const txns = await api.transactions(month);

  view.innerHTML = `
    <div class="row" id="tx-head"></div>
    <div class="filters">
      <select id="f-type">
        <option value="">All types</option>
        ${["BNPL", "Instalment", "Bill Payment", "Refund"].map((t) => `<option>${t}</option>`).join("")}
      </select>
      <input id="f-search" type="search" placeholder="Search merchant…" />
    </div>
    <ul class="tx-list" id="tx-list"></ul>`;
  $("#tx-head").append(monthSelector(months, month, (m) => ((state.month = m), renderTransactions())));

  const list = $("#tx-list");
  const draw = () => {
    const type = $("#f-type").value;
    const q = $("#f-search").value.toLowerCase();
    const rows = txns.filter(
      (t) => (!type || t.type === type) && (!q || t.merchant.toLowerCase().includes(q)),
    );
    list.innerHTML =
      rows
        .map(
          (t) => `
      <li class="tx" data-id="${t.id}">
        <div class="tx-main">
          <div class="tx-merchant">${esc(t.merchant)}</div>
          <div class="tx-meta">${t.date} · ${esc(t.type)}${t.channel === "in_store" ? " · in store" : ""}</div>
        </div>
        <div class="tx-amount ${t.sign === "+" ? "pos" : ""}">${t.sign}${fmtRM(t.amount)}</div>
        <button class="tx-del" title="Delete" aria-label="Delete">✕</button>
      </li>`,
        )
        .join("") || `<div class="empty">No matches.</div>`;
  };
  draw();
  $("#f-type").onchange = draw;
  $("#f-search").oninput = draw;

  list.onclick = async (e) => {
    if (!e.target.classList.contains("tx-del")) return;
    const li = e.target.closest(".tx");
    const t = txns.find((x) => x.id === li.dataset.id);
    if (!confirm(`Delete ${t.merchant} ${t.sign}${fmtRM(t.amount)} on ${t.date}?`)) return;
    try {
      await api.remove(t.id, month);
      invalidate();
      txns.splice(txns.indexOf(t), 1);
      draw();
      toast("Deleted");
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ---------- Add ----------

function renderAdd() {
  view.innerHTML = `
    <h2>Paste from ShopeePay</h2>
    <textarea id="paste" rows="8" placeholder="BNPL&#10;In Store - SOME SHOP&#10;29 May 2026&#10;-RM10.00"></textarea>
    <button id="btn-parse" class="primary">Preview</button>
    <div id="preview"></div>

    <h2>Or add manually</h2>
    <form id="manual">
      <select name="type" required>
        ${["BNPL", "Instalment", "Bill Payment", "Refund"].map((t) => `<option>${t}</option>`).join("")}
      </select>
      <input name="description" placeholder="Description" required />
      <div class="row">
        <input name="date" type="date" required />
        <select name="sign"><option value="-">− charge</option><option value="+">+ credit</option></select>
        <input name="amount" type="number" step="0.01" min="0.01" placeholder="Amount" required />
      </div>
      <button class="primary">Add transaction</button>
    </form>`;

  $("#btn-parse").onclick = () => {
    const { transactions, errors, ignored } = parseShopeePay($("#paste").value);
    const box = $("#preview");
    if (!transactions.length && !errors.length) {
      box.innerHTML = `<div class="empty">Nothing to parse.</div>`;
      return;
    }
    box.innerHTML = `
      ${errors.length ? `<div class="warn">${errors.length} problem(s):<br>${errors.map((e) => `line ${e.line}: ${esc(e.message)}`).join("<br>")}</div>` : ""}
      ${ignored.length ? `<div class="empty" style="padding:0.3rem 0">${ignored.length} non-transaction line(s) skipped</div>` : ""}
      <table class="preview-table">
        <tr><th>Date</th><th>Type</th><th>Description</th><th class="r">Amount</th></tr>
        ${transactions
          .map(
            (t) =>
              `<tr><td>${t.date}</td><td>${esc(t.type)}</td><td>${esc(t.description)}</td><td class="r">${t.sign}${fmtRM(t.amount)}</td></tr>`,
          )
          .join("")}
      </table>
      <button id="btn-import" class="primary">Import ${transactions.length} transaction(s)</button>`;
    $("#btn-import").onclick = async () => {
      $("#btn-import").disabled = true;
      try {
        const r = await api.importTransactions(transactions);
        invalidate();
        toast(`Imported: ${r.added} added, ${r.skipped} duplicates skipped`);
        $("#paste").value = "";
        box.innerHTML = "";
      } catch (err) {
        toast(err.message, true);
        $("#btn-import").disabled = false;
      }
    };
  };

  $("#manual").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api.importTransactions([
        {
          date: f.get("date"),
          type: f.get("type"),
          description: f.get("description"),
          sign: f.get("sign"),
          amount: Number(f.get("amount")),
        },
      ]);
      invalidate();
      toast(r.added ? "Added" : "Duplicate — skipped");
      e.target.reset();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ---------- Settings ----------

function renderSettings() {
  view.innerHTML = `
    <h2>Settings</h2>
    <label>API URL
      <input id="set-api" value="${esc(cfg.apiBase)}" placeholder="https://shpp-tracker.xxx.workers.dev" />
    </label>
    <label>Token <small>(kept only for this browser session)</small>
      <input id="set-token" type="password" value="${esc(cfg.token)}" placeholder="DASHBOARD_TOKEN" />
    </label>
    <button id="btn-save" class="primary">Save & test connection</button>
    <hr />
    <button id="btn-export">Download backup (JSON)</button>`;

  $("#btn-save").onclick = async () => {
    cfg.apiBase = $("#set-api").value;
    cfg.token = $("#set-token").value;
    try {
      await api.months();
      toast("Connected ✓");
    } catch (err) {
      toast(err.message, true);
    }
  };

  $("#btn-export").onclick = async () => {
    try {
      const dump = await api.exportAll();
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `shpp-tracker-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ---------- Router ----------

const state = { month: null };
const routes = {
  dashboard: renderDashboard,
  transactions: renderTransactions,
  add: renderAdd,
  settings: renderSettings,
};

async function navigate(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  try {
    await routes[name]();
  } catch (err) {
    view.innerHTML = `
      <div class="error-state">
        <p>${esc(err.message)}</p>
        <button class="primary" id="btn-retry">Retry</button>
        <button id="btn-goto-settings">Open Settings</button>
      </div>`;
    $("#btn-retry").onclick = () => (invalidate(), navigate(name));
    $("#btn-goto-settings").onclick = () => navigate("settings");
  }
}

document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => navigate(b.dataset.tab)));
navigate(cfg.token ? "dashboard" : "settings");
