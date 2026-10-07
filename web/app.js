// ShopeePay BNPL Tracker SPA — four views on a bottom tab bar (SPEC.md §4).

import { api, cfg } from "./api.js";
import { parseShopeePay } from "./parser.js";
import { reconcile } from "./reconcile.js";

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

const tag = (text, cls = "") => `<span class="tag ${cls}">${esc(text)}</span>`;

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
  if (!cache.months) {
    const meta = await api.months();
    cache.months = [...new Set([...meta.months, ...(meta.historyMonths ?? [])])].sort();
  }
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
      ${
        s.hasBill
          ? `<div class="card"><div class="card-label">Bill</div><div class="card-value">${fmtRM(s.charges)}</div><div class="card-sub">${s.dated}/${s.billItems} dated from transactions</div></div>`
          : `<div class="card"><div class="card-label">Estimate</div><div class="card-value">${fmtRM(s.charges)}</div><div class="card-sub">no bill yet · from transactions</div></div>`
      }
      <div class="card"><div class="card-label">Repayments</div><div class="card-value">${fmtRM(s.payments)}</div><div class="card-sub">Bill Payment this month</div></div>
      ${
        s.hasBill && s.pending
          ? `<div class="card wide"><div class="card-label">Not yet billed</div><div class="card-value">${fmtRM(s.pending)}</div><div class="card-sub">purchases this month expected on a later bill</div></div>`
          : ""
      }
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

// One combined list per month. A bill item matched to its history record is a
// single row (the bill's amount, the purchase's real date); tapping a row opens
// the detail sheet with both sides. History records not on this month's bill
// (repayments, unbilled purchases, purchases billed in another month) are rows
// of their own, tagged with their billing status.
const isPurchase = (t) => t.type === "BNPL" || t.type === "Instalment";

function segmented(options, selected, onChange) {
  const el = document.createElement("div");
  el.className = "seg";
  el.innerHTML = options
    .map(([value, label]) => `<button data-v="${value}" class="${value === selected ? "on" : ""}">${label}</button>`)
    .join("");
  el.onclick = (e) => {
    const v = e.target.dataset?.v;
    if (v && v !== selected) onChange(v);
  };
  return el;
}

/** Rows for one month: `bill` and/or `hist` record; `date` = purchase date or null. */
function combineRows(bills, history, histById) {
  const claimed = new Set(bills.map((b) => b.ref).filter(Boolean));
  const rows = bills.map((b) => {
    const hist = (b.ref && histById.get(b.ref)) || null;
    return { key: `b:${b.id}`, bill: b, hist, date: hist?.date ?? b.txnDate ?? null };
  });
  for (const h of history) if (!claimed.has(h.id)) rows.push({ key: `h:${h.id}`, bill: null, hist: h, date: h.date });
  // By date; undated bill items last.
  return rows.sort((a, b) => (a.date ?? "9").localeCompare(b.date ?? "9"));
}

const rowTxn = (r) => r.bill ?? r.hist;
const fmtDate = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" });

async function renderTransactions() {
  view.innerHTML = `<div class="loading">Loading…</div>`;
  const months = await loadMonths();
  if (!months.length) {
    view.innerHTML = `<div class="empty">No data yet — import from the <b>Add</b> tab.</div>`;
    return;
  }
  const month = state.month && months.includes(state.month) ? state.month : months[months.length - 1];
  state.month = month;
  const [stored, history] = await Promise.all([api.bill(month), api.history(month)]);
  // Rows saved before bills and history were split have no `statement` and
  // are never matched until Settings ▸ Check older data sorts them out.
  const legacy = stored.some((b) => !b.statement);
  const bills = stored.map((b) => (b.statement ? b : { ...b, statement: month }));
  // Bill items can be dated from an earlier month's history (online orders,
  // later instalment parts) — fetch those too so their details can be shown.
  const otherMonths = [...new Set(bills.map((b) => b.txnDate?.slice(0, 7)).filter((m) => m && m !== month))];
  const others = (await Promise.all(otherMonths.map((m) => api.history(m).catch(() => [])))).flat();
  const histById = new Map([...history, ...others].map((h) => [h.id, h]));
  const rows = combineRows(bills, history, histById);

  const dated = rows.filter((r) => r.bill && r.date).length;
  const unbilled = rows.filter((r) => !r.bill && isPurchase(r.hist) && !r.hist.billedIn).length;
  const repayments = rows.filter((r) => r.hist?.type === "Bill Payment").length;
  const summary = [
    bills.length ? `${bills.length} on ${monthLabel(month)} bill · ${dated} dated` : "No bill imported",
    unbilled ? `${unbilled} not yet billed` : "",
    repayments ? `${repayments} repayment(s)` : "",
  ].filter(Boolean);

  view.innerHTML = `
    <div class="row" id="tx-head"></div>
    <div class="filters">
      <select id="f-type">
        <option value="">All types</option>
        ${["BNPL", "Instalment", "Bill Payment", "Refund"].map((t) => `<option>${t}</option>`).join("")}
      </select>
      <input id="f-search" type="search" placeholder="Search merchant…" />
    </div>
    ${legacy ? `<div class="warn">This month has older data that can't be matched yet. Run <b>Settings ▸ Check older data</b> once to link it.</div>` : ""}
    <p class="hint">${summary.join(" · ")}</p>
    <ul class="tx-list" id="tx-list"></ul>`;
  $("#tx-head").append(monthSelector(months, month, (m) => ((state.month = m), renderTransactions())));

  const meta = (r) => {
    const t = rowTxn(r);
    const bits = [
      r.date ?? "date unknown",
      esc(t.type) + (t.part ? ` ${t.part}/${t.of}` : ""),
      t.channel === "in_store" ? "in store" : "",
    ].filter(Boolean);
    let tags = "";
    if (!r.bill && r.hist.billedIn) tags = tag(`on ${monthLabel(r.hist.billedIn)} bill`, "muted");
    else if (!r.bill && isPurchase(r.hist)) tags = tag("not yet billed", "pending");
    return bits.join(" · ") + tags;
  };

  const list = $("#tx-list");
  const draw = () => {
    const type = $("#f-type").value;
    const q = $("#f-search").value.toLowerCase();
    const shown = rows.filter((r) => {
      const t = rowTxn(r);
      return (!type || t.type === type) && (!q || t.merchant.toLowerCase().includes(q));
    });
    list.innerHTML =
      shown
        .map((r) => {
          const t = rowTxn(r);
          return `
      <li class="tx" data-key="${r.key}" role="button" tabindex="0">
        <div class="tx-main">
          <div class="tx-merchant">${esc(t.merchant)}</div>
          <div class="tx-meta">${meta(r)}</div>
        </div>
        <div class="tx-amount ${t.sign === "+" ? "pos" : ""}">${t.sign}${fmtRM(t.amount)}</div>
        <span class="tx-chev" aria-hidden="true">›</span>
      </li>`;
        })
        .join("") || `<div class="empty">${rows.length ? "No matches." : "Nothing saved for this month."}</div>`;
  };
  draw();
  $("#f-type").onchange = draw;
  $("#f-search").oninput = draw;

  const open = (e) => {
    const li = e.target.closest(".tx");
    if (li) showDetail(rows.find((r) => r.key === li.dataset.key));
  };
  list.onclick = open;
  list.onkeydown = (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    open(e);
  };
}

/** Bottom sheet with everything known about a row; deleting happens here. */
function showDetail(row) {
  const { bill, hist } = row;
  const t = rowTxn(row);
  const field = (label, value) => (value ? `<dt>${label}</dt><dd>${value}</dd>` : "");

  let billing = "";
  if (bill) billing = `${monthLabel(bill.statement)} bill`;
  else if (hist.billedIn) billing = `${monthLabel(hist.billedIn)} bill`;
  else if (isPurchase(hist)) billing = tag("not yet billed", "pending");

  const purchased = row.date
    ? fmtDate(row.date)
    : `<span class="muted">Unknown — paste this month's transaction history to match it</span>`;
  let plan = "";
  if (bill?.part && hist) plan = `Part ${bill.part} of ${bill.of} · plan total ${fmtRM(hist.amount)}`;
  else if (bill?.part) plan = `Part ${bill.part} of ${bill.of}`;
  // History titles are often fuller than the bill's (promo tags, variants).
  const twoDescs = bill && hist && bill.description !== hist.description;
  let source = "Transaction history";
  if (bill && hist) source = "Bill item, matched to transaction history";
  else if (bill) source = "Bill item (no matching transaction yet)";

  const dlg = document.createElement("dialog");
  dlg.className = "sheet";
  dlg.innerHTML = `
    <div class="sheet-head">
      <div class="sheet-title">${esc(t.merchant)}</div>
      <div class="sheet-amount ${t.sign === "+" ? "pos" : ""}">${t.sign}${fmtRM(t.amount)}</div>
    </div>
    <dl class="detail">
      ${field("Type", esc(t.type) + " · " + (t.channel === "in_store" ? "In store" : "Online"))}
      ${field("Purchased", purchased)}
      ${field("Billed on", billing)}
      ${field("Instalment", plan)}
      ${field(twoDescs ? "On bill as" : "Description", esc(t.description))}
      ${field("Transaction", twoDescs ? esc(hist.description) : "")}
      ${field("Source", source)}
      ${field("Imported", fmtDate(t.importedAt.slice(0, 10)))}
    </dl>
    <div class="sheet-actions">
      ${bill ? `<button data-del="bill">Delete bill item</button>` : ""}
      ${hist ? `<button data-del="history">Delete transaction</button>` : ""}
      <button class="primary" data-close>Close</button>
    </div>`;
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.onclick = async (e) => {
    // A tap on the backdrop lands on the dialog element itself.
    if (e.target === dlg || "close" in e.target.dataset) return dlg.close();
    const kind = e.target.dataset.del;
    if (!kind) return;
    const rec = kind === "bill" ? bill : hist;
    const what = kind === "bill" ? `this ${monthLabel(bill.statement)} bill item` : "this transaction";
    if (!confirm(`Delete ${what}: ${rec.merchant} ${rec.sign}${fmtRM(rec.amount)}?`)) return;
    try {
      await api.remove(kind, rec.id, rec.date.slice(0, 7));
      invalidate();
      dlg.close();
      toast("Deleted");
      renderTransactions();
    } catch (err) {
      toast(err.message, true);
    }
  };
  dlg.showModal();
}

// ---------- Add ----------

const prevMonth = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7);
};
const nextMonth = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
};

// Best-effort: stored records for the preview's match hints. The real match
// runs in the Worker on import; a failed fetch just means fewer hints.
async function stored(kind, months) {
  const fetch1 = kind === "bill" ? api.bill : api.history;
  const res = await Promise.all([...new Set(months)].map((m) => fetch1(m).catch(() => [])));
  return res.flat();
}

const ADD_PANELS = {
  bill: {
    title: "Monthly bill",
    hint: "Paste the bill / statement (Bill Amount, Total N transactions, BNPL + Instalment sections). Only bill items are imported.",
    placeholder: "Bill Amount&#10;+ RM1,209.98&#10;Total 44 transactions&#10;01 Sep - 30 Sep&#10;&#10;BNPL&#10;In Store - SOME SHOP&#10;RM8.00",
  },
  history: {
    title: "Transactions",
    hint: "Paste the transaction history (each item with its date). Saved separately; used to date bill items and track repayments.",
    placeholder: "BNPL&#10;In Store - SOME SHOP&#10;29 Sep 2026&#10;RM8.00",
  },
};

function renderAdd() {
  const kind = state.addKind;
  const panel = ADD_PANELS[kind];
  view.innerHTML = `
    <div class="row" id="add-head"></div>
    <h2>${panel.title}</h2>
    <p class="hint">${panel.hint}</p>
    <textarea id="paste" rows="8" placeholder="${panel.placeholder}"></textarea>
    <button id="btn-parse" class="primary">Preview</button>
    <div id="preview"></div>

    ${
      kind === "history"
        ? `<h2>Or add one manually</h2>
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
    </form>`
        : ""
    }`;
  $("#add-head").append(
    segmented([["bill", "Bill"], ["history", "Transactions"]], kind, (v) => ((state.addKind = v), renderAdd())),
  );

  $("#btn-parse").onclick = async () => {
    const parsed = parseShopeePay($("#paste").value);
    const box = $("#preview");
    const items = parsed.transactions.filter((t) => (kind === "bill") === Boolean(t.statement));
    const wrongPanel = parsed.transactions.length - items.length;
    const errors = [...parsed.errors];
    if (!items.length && !errors.length && !wrongPanel) {
      box.innerHTML = `<div class="empty">Nothing to parse.</div>`;
      return;
    }

    box.innerHTML = `<div class="loading">Checking saved ${kind === "bill" ? "transactions" : "bills"}…</div>`;
    let note = "";
    let dateOf = () => null;
    let billOf = () => null;
    if (kind === "bill" && items.length) {
      const stmts = [...new Set(items.map((t) => t.statement))];
      const history = await stored("history", stmts.flatMap((m) => [prevMonth(prevMonth(m)), prevMonth(m), m]));
      const { pairs } = reconcile([...items, ...history]);
      dateOf = (t) => pairs.get(t)?.date ?? null;
      note = `${stmts.map(monthLabel).join(", ")} bill: <b>${items.length}</b> item(s) · <b>${pairs.size}</b> dated from saved transactions${
        history.length ? "" : " (none saved yet — add them in the Transactions panel)"
      }.`;
    } else if (kind === "history" && items.length) {
      const months = [...new Set(items.map((t) => t.date.slice(0, 7)))];
      const bills = await stored("bill", months.flatMap((m) => [m, nextMonth(m)]));
      const { billedIn } = reconcile([...bills, ...items]);
      billOf = (t) => billedIn.get(t) ?? null;
      const onBill = items.filter((t) => billedIn.has(t)).length;
      const pays = items.filter((t) => t.type === "Bill Payment");
      note = `<b>${items.length}</b> transaction(s)${bills.length ? ` · <b>${onBill}</b> found on a saved bill` : ""}${
        pays.length ? ` · ${pays.length} repayment(s) ${fmtRM(pays.reduce((a, t) => a + t.amount, 0))}` : ""
      }.`;
    }

    if (wrongPanel) {
      errors.unshift({
        line: 0,
        message:
          kind === "bill"
            ? `${wrongPanel} dated transaction row(s) skipped — paste those in the Transactions panel`
            : `${wrongPanel} bill item(s) skipped — paste the bill in the Bill panel`,
      });
    }

    const dateCell = (t) => {
      if (kind === "history") return t.date;
      const d = dateOf(t);
      return d ?? `<span class="muted">${monthLabel(t.statement)}</span>`;
    };
    const statusTag = (t) => {
      if (kind !== "history" || !isPurchase(t)) return "";
      const b = billOf(t);
      return " " + (b ? tag(`on ${monthLabel(b)} bill`, "muted") : tag("not yet billed", "pending"));
    };

    box.innerHTML = `
      ${errors.length ? `<div class="warn">${errors.length} problem(s):<br>${errors.map((e) => `${e.line ? `line ${e.line}: ` : ""}${esc(e.message)}`).join("<br>")}</div>` : ""}
      ${parsed.ignored.length ? `<div class="empty" style="padding:0.3rem 0">${parsed.ignored.length} non-transaction line(s) skipped</div>` : ""}
      ${note ? `<div class="note">${note}</div>` : ""}
      ${
        items.length
          ? `<table class="preview-table">
        <tr><th>Date</th><th>Type</th><th>Description</th><th class="r">Amount</th></tr>
        ${items
          .map(
            (t) =>
              `<tr><td>${dateCell(t)}</td><td>${esc(t.type)}</td><td>${esc(t.description)}${statusTag(t)}</td><td class="r">${t.sign}${fmtRM(t.amount)}</td></tr>`,
          )
          .join("")}
      </table>
      <button id="btn-import" class="primary">Import ${items.length} ${kind === "bill" ? "bill item(s)" : "transaction(s)"}</button>`
          : ""
      }`;
    if (!items.length) return;
    $("#btn-import").onclick = async () => {
      $("#btn-import").disabled = true;
      try {
        const r = await api.importItems(kind, items);
        invalidate();
        toast(
          `Imported: ${r.added} added, ${r.skipped} duplicates skipped` +
            (r.billItems ? ` · ${r.dated}/${r.billItems} bill items dated` : ""),
        );
        $("#paste").value = "";
        box.innerHTML = "";
      } catch (err) {
        toast(err.message, true);
        $("#btn-import").disabled = false;
      }
    };
  };

  const form = $("#manual");
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const r = await api.importItems("history", [
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
    <button id="btn-export">Download backup (JSON)</button>
    <hr />
    <h2>Data</h2>
    <p class="hint">Older imports kept bill items and transaction history in one place. This moves history rows into the separate Transactions store and tags old bill items. Download a backup first.</p>
    <button id="btn-migrate">Check older data…</button>`;

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

  $("#btn-migrate").onclick = async () => {
    const btn = $("#btn-migrate");
    btn.disabled = true;
    try {
      const plan = await api.migrate(true);
      if (!plan.movedToHistory && !plan.taggedAsBill) {
        toast("Nothing to migrate — data is already split");
        return;
      }
      const lines = Object.entries(plan.byMonth)
        .map(([m, v]) => `${monthLabel(m)}: ${v.movedToHistory} → Transactions, ${v.taggedAsBill} tagged as bill`)
        .join("\n");
      if (!confirm(`Migrate older data?\n\n${lines}`)) return;
      const r = await api.migrate(false);
      invalidate();
      toast(`Migrated: ${r.movedToHistory} moved to Transactions, ${r.taggedAsBill} bill items tagged`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------- Router ----------

const state = { month: null, addKind: "bill" };
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
