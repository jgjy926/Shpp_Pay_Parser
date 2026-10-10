// Transaction store on top of Koofr — monthly shards + meta.json (SPEC.md §2).
//
// Two kinds of shard, kept apart so a bill never absorbs history rows:
//   transactions/YYYY-MM.json — bill items from the monthly statement
//   history/YYYY-MM.json      — transaction history (dated purchases,
//                               repayments, refunds, manual entries)
// Reconciliation links them: bill items gain the real purchase date
// (`txnDate`/`ref`) and claimed history records gain `billedIn`.

import { KoofrClient, KoofrConflictError, type KoofrFile } from "./koofr";
import { EMPTY_META, type IncomingTransaction, type Kind, type Meta, type Transaction } from "./types";
import { reconcile } from "../../web/reconcile.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Months to read either side of the touched ones when reconciling: covers a
 *  12-part instalment plan bought up to a year before the bill that bills it. */
const WINDOW_MONTHS = 12;

const DIRS: Record<Kind, string> = { bill: "transactions", history: "history" };

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

interface Shard {
  kind: Kind;
  month: string;
  etag: string | null;
  before: string; // serialized as read, to skip unchanged writes
  txns: Transaction[];
}

type Shards = Map<string, Shard>; // key: `${kind}:${month}`

const isCharge = (t: Transaction) => t.type === "BNPL" || t.type === "Instalment";
const sum = (ts: Transaction[]) => round2(ts.reduce((a, t) => a + t.amount, 0));

async function sha1Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic id base — dedupe relies on this exact recipe (amount fixed to 2dp). */
export function idInput(t: IncomingTransaction): string {
  return `${t.date}|${t.type}|${t.description}|${t.amount.toFixed(2)}`;
}

/**
 * Id hash input for the `occ`-th item sharing the same {@link idInput} base
 * within one import. Grouped monthly statements have no per-item date, so all
 * items in a statement share a date and genuine same-merchant/same-amount
 * repeats (e.g. two RM10.50 fishball runs) would otherwise collapse to one.
 * The first occurrence keeps the bare base id (so re-imports of pre-existing
 * per-day records still dedupe unchanged); repeats get a stable `|#N` suffix.
 * Counting by base makes the id set order-independent, so re-importing the
 * same statement stays idempotent even if ShopeePay reorders the rows.
 */
function idHashInput(base: string, occ: number): string {
  return occ === 0 ? base : `${base}|#${occ}`;
}

/** `In Store - X` → merchant X / in_store; anything else is an online purchase.
 *  A leading instalment tag (`[1/3] `) is stripped first so the plan's parts
 *  group under one merchant. */
function deriveMerchant(description: string): { merchant: string; channel: "in_store" | "online" } {
  const cleaned = description.replace(/^\[\d+\/\d+\]\s*/, "").trim();
  const m = cleaned.match(/^In Store - (.+)$/i);
  return m
    ? { merchant: m[1].trim(), channel: "in_store" }
    : { merchant: cleaned, channel: "online" };
}

export interface MonthSummary {
  month: string;
  hasBill: boolean; // a statement for this month has been imported
  count: number; // records behind `charges`
  charges: number; // the bill's charges, or (no bill yet) the month's history purchases as an estimate
  billed: number; // BNPL + Instalment on this month's statement
  pending: number; // history purchases this month not on any statement yet
  payments: number; // Bill Payment (repayments) made this month, from history
  refunds: number;
  net: number; // charges - payments - refunds
  dated: number; // bill items with a real purchase date from history
  billItems: number;
  byType: Record<string, { count: number; total: number }>;
  topMerchants: { merchant: string; total: number; count: number }[];
}

export interface MigrationReport {
  dryRun: boolean;
  /** history rows found in bill shards and moved to history/ */
  movedToHistory: number;
  /** untagged grouped-statement rows recognised as bill items and tagged */
  taggedAsBill: number;
  /** rows already saved in history/ (re-pasted since) — removed */
  dropped: number;
  byMonth: Record<string, { movedToHistory: number; taggedAsBill: number; dropped: number }>;
  /** month the next call resumes from; null when every month is done */
  next: string | null;
}

/** Bill months a single migrate call handles. Each costs up to ~8 Koofr
 *  requests, and a Worker invocation may make 50 subrequests (free plan). */
const MIGRATE_BATCH = 5;

/** Sort the untagged rows of bill shard `month` — see {@link Store.migrate}. */
export function planMigration(shard: Transaction[], history: Transaction[], month: string) {
  const last = lastDayOf(month);
  const batch = new Map<string, number>(); // importedAt -> rows on the last day
  for (const t of shard) {
    if (!t.statement && t.date === last) batch.set(t.importedAt, (batch.get(t.importedAt) ?? 0) + 1);
  }
  const isLegacyBill = (t: Transaction) =>
    !t.statement && t.date === last && t.type !== "Bill Payment" && (batch.get(t.importedAt) ?? 0) >= 5;
  const rest = shard.filter((t) => !t.statement && !isLegacyBill(t));

  // History rows not already claimed by id, counted per date/type/amount, so
  // two identical purchases on one day still need two history rows to drop.
  const ids = new Set(history.map((h) => h.id));
  const restIds = new Set(rest.map((t) => t.id));
  const key = (t: Transaction) => `${t.date}|${t.type}|${t.amount.toFixed(2)}`;
  const spare = new Map<string, number>();
  for (const h of history) if (!restIds.has(h.id)) spare.set(key(h), (spare.get(key(h)) ?? 0) + 1);

  const drop: Transaction[] = [];
  const move: Transaction[] = [];
  for (const t of rest) {
    const n = spare.get(key(t)) ?? 0;
    if (ids.has(t.id)) drop.push(t);
    else if (n > 0) {
      spare.set(key(t), n - 1);
      drop.push(t);
    } else move.push(t);
  }
  return { tag: shard.filter(isLegacyBill), drop, move };
}

export class Store {
  constructor(private koofr: KoofrClient) {}

  #path(kind: Kind, month: string): string {
    return `${DIRS[kind]}/${month}.json`;
  }

  /** Read-merge-write with one retry on ETag conflict (SPEC.md §2). */
  async #updateJson<T>(path: string, empty: T, mutate: (current: T) => T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const current = await this.koofr.getJson<T>(path);
      const next = mutate(current ? current.data : empty);
      try {
        await this.koofr.putJson(path, next, current?.etag);
        return next;
      } catch (e) {
        if (!(e instanceof KoofrConflictError) || attempt >= 1) throw e;
      }
    }
  }

  async getMeta(): Promise<Meta> {
    const file = await this.koofr.getJson<Meta>("meta.json");
    return { ...EMPTY_META, ...file?.data };
  }

  async getShard(kind: Kind, month: string): Promise<Transaction[]> {
    const file = await this.koofr.getJson<Transaction[]>(this.#path(kind, month));
    return file?.data ?? [];
  }

  async #touchMeta(kind: Kind, months: Iterable<string>): Promise<void> {
    const key = kind === "bill" ? "months" : "historyMonths";
    await this.#updateJson<Meta>("meta.json", EMPTY_META, (meta) => ({
      ...EMPTY_META,
      ...meta,
      [key]: [...new Set([...(meta[key] ?? []), ...months])].sort(),
      lastSync: new Date().toISOString(),
    }));
  }

  /**
   * Load every existing bill and history shard within WINDOW_MONTHS of
   * `touched`, let `mutate` edit them, re-run bill↔history reconciliation over
   * the lot, then write back only the shards that changed. Retries once on an
   * ETag conflict.
   */
  async #withWindow<R>(touched: string[], mutate: (shards: Shards, get: (k: Kind, m: string) => Shard) => R): Promise<R> {
    const sorted = [...touched].sort();
    const lo = shiftMonth(sorted[0], -WINDOW_MONTHS);
    const hi = shiftMonth(sorted[sorted.length - 1], WINDOW_MONTHS);
    const latestTouched = sorted[sorted.length - 1];
    const inWindow = (m: string) => m >= lo && m <= hi;

    for (let attempt = 0; ; attempt++) {
      const meta = await this.getMeta();
      const wanted: [Kind, string][] = [
        ...meta.months.filter(inWindow).map((m): [Kind, string] => ["bill", m]),
        ...meta.historyMonths.filter(inWindow).map((m): [Kind, string] => ["history", m]),
      ];
      const files = await Promise.all(
        wanted.map(([k, m]) => this.koofr.getJson<Transaction[]>(this.#path(k, m))),
      );
      const shards: Shards = new Map();
      wanted.forEach(([kind, month], i) => {
        const f: KoofrFile<Transaction[]> | null = files[i];
        const before = JSON.stringify(f?.data ?? []);
        shards.set(`${kind}:${month}`, { kind, month, etag: f?.etag ?? null, before, txns: JSON.parse(before) });
      });
      // Shards not in meta yet are created on demand by `mutate`.
      const get = (kind: Kind, month: string): Shard => {
        const key = `${kind}:${month}`;
        if (!shards.has(key)) shards.set(key, { kind, month, etag: null, before: "[]", txns: [] });
        return shards.get(key)!;
      };

      const result = mutate(shards, get);

      // Untagged rows in bill shards are pre-split data awaiting /api/migrate;
      // reconcile would take them for history and pair bill items with them.
      const bills = [...shards.values()]
        .filter((s) => s.kind === "bill")
        .flatMap((s) => s.txns)
        .filter((t) => t.statement);
      const history = [...shards.values()].filter((s) => s.kind === "history").flatMap((s) => s.txns);
      const { pairs, billedIn } = reconcile([...bills, ...history]);
      for (const b of bills) {
        const h = pairs.get(b) as Transaction | undefined;
        if (h) {
          b.txnDate = h.date;
          b.ref = h.id;
        } else if (b.ref && !history.some((x) => x.id === b.ref) && b.date.slice(0, 7) >= sorted[0]) {
          // Its history record was deleted (and the whole lookback was loaded).
          delete b.txnDate;
          delete b.ref;
        }
      }
      for (const h of history) {
        const s = billedIn.get(h);
        if (s) h.billedIn = s;
        // Clear only where every statement that could claim this record
        // (up to WINDOW_MONTHS later) was loaded.
        else if (h.date.slice(0, 7) <= latestTouched) delete h.billedIn;
      }

      try {
        for (const s of shards.values()) {
          s.txns.sort((a, b) => a.date.localeCompare(b.date));
          if (JSON.stringify(s.txns) === s.before) continue;
          await this.koofr.putJson(this.#path(s.kind, s.month), s.txns, s.etag);
        }
      } catch (e) {
        if (!(e instanceof KoofrConflictError) || attempt >= 1) throw e;
        continue;
      }
      return result;
    }
  }

  async #prepare(incoming: IncomingTransaction[]): Promise<Transaction[]> {
    const importedAt = new Date().toISOString();
    // Assign each item an occurrence index among items sharing its id base, so
    // legitimate duplicates within a statement each get a distinct id.
    const bases = incoming.map(idInput);
    const counts = new Map<string, number>();
    const occ = bases.map((b) => {
      const n = counts.get(b) ?? 0;
      counts.set(b, n + 1);
      return n;
    });
    return Promise.all(
      incoming.map(async (t, i) => ({
        id: await sha1Hex(idHashInput(bases[i], occ[i])),
        date: t.date,
        type: t.type,
        description: t.description.trim(),
        sign: t.sign,
        amount: round2(t.amount),
        currency: "MYR" as const,
        importedAt,
        ...(t.merchant && t.channel
          ? { merchant: t.merchant.trim(), channel: t.channel }
          : deriveMerchant(t.description)),
        ...(t.statement ? { statement: t.statement } : {}),
        ...(t.part && t.of ? { part: t.part, of: t.of } : {}),
      })),
    );
  }

  /**
   * Bulk upsert into one kind of shard (by month, dedupe by deterministic id),
   * then reconcile against the other kind. Returns how many of the bill items
   * involved (this import's for a bill; the window's for history) are dated.
   */
  async upsert(
    kind: Kind,
    incoming: IncomingTransaction[],
  ): Promise<{ added: number; skipped: number; billItems: number; dated: number }> {
    const prepared = await this.#prepare(incoming);
    const byMonth = new Map<string, Transaction[]>();
    for (const t of prepared) {
      const month = t.date.slice(0, 7);
      byMonth.set(month, [...(byMonth.get(month) ?? []), t]);
    }

    let tracked: Transaction[] = [];
    const counts = await this.#withWindow([...byMonth.keys()], (shards, get) => {
      let added = 0;
      let skipped = 0;
      const mine: Transaction[] = []; // stored copies of this import's records
      for (const [month, txns] of byMonth) {
        const shard = get(kind, month);
        const existing = new Map(shard.txns.map((t) => [t.id, t]));
        for (const t of txns) {
          const old = existing.get(t.id);
          mine.push(old ?? t);
          if (!old) {
            shard.txns.push(t);
            existing.set(t.id, t); // also dedupes within the batch itself
            added++;
          } else {
            skipped++;
          }
        }
      }
      // Bill import: report on its own items. History import: report on the
      // bill items it can now date — those of the touched months and the next.
      tracked =
        kind === "bill"
          ? mine
          : [...shards.values()]
              .filter((s) => s.kind === "bill" && [...byMonth.keys()].some((m) => s.month >= m && s.month <= shiftMonth(m, 1)))
              .flatMap((s) => s.txns);
      return { added, skipped };
    });

    await this.#touchMeta(kind, byMonth.keys());

    // Reconciliation mutated the stored objects in place.
    return { ...counts, billItems: tracked.length, dated: tracked.filter((t) => t.txnDate).length };
  }

  /** Returns true if the record existed and was removed. Re-reconciles, so
   *  deleting a bill item returns its history record to "not yet billed". */
  async delete(kind: Kind, month: string, id: string): Promise<boolean> {
    return this.#withWindow([month], (_shards, get) => {
      const shard = get(kind, month);
      const before = shard.txns.length;
      shard.txns = shard.txns.filter((t) => t.id !== id);
      return shard.txns.length < before;
    });
  }

  async summary(month: string): Promise<MonthSummary> {
    const [bill, history] = await Promise.all([this.getShard("bill", month), this.getShard("history", month)]);

    const hasBill = bill.length > 0;
    // History already claimed by a statement is counted via its bill item.
    const unbilled = history.filter((t) => !t.billedIn && (isCharge(t) || t.type === "Refund"));
    const payments = history.filter((t) => t.type === "Bill Payment");
    // With a bill, the month is the bill; without one, the month's purchases
    // are the estimate (an instalment plan counts in full in its purchase month).
    const basis = hasBill ? bill : history.filter((t) => isCharge(t) || t.type === "Refund");

    const byType: MonthSummary["byType"] = {};
    const merchants = new Map<string, { total: number; count: number }>();
    for (const t of [...basis, ...payments]) {
      byType[t.type] ??= { count: 0, total: 0 };
      byType[t.type].count++;
      byType[t.type].total = round2(byType[t.type].total + t.amount);

      if (isCharge(t)) {
        const m = merchants.get(t.merchant) ?? { total: 0, count: 0 };
        m.total = round2(m.total + t.amount);
        m.count++;
        merchants.set(t.merchant, m);
      }
    }

    const charges = sum(basis.filter(isCharge));
    const refunds = sum(basis.filter((t) => t.type === "Refund"));
    const paid = sum(payments);
    const billed = sum(bill.filter(isCharge));

    return {
      month,
      hasBill,
      count: basis.length,
      charges,
      billed,
      pending: sum(unbilled.filter(isCharge)),
      payments: paid,
      refunds,
      net: round2(charges - paid - refunds),
      dated: bill.filter((t) => t.txnDate).length,
      billItems: bill.length,
      byType,
      topMerchants: [...merchants.entries()]
        .map(([merchant, v]) => ({ merchant, ...v }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 5),
    };
  }

  /**
   * One-off split of data stored before bills and history had separate
   * folders. Every bill shard row without `statement` is either:
   *  - an untagged grouped-statement item (dated the month's last day,
   *    imported in a batch of ≥5 sharing that date) — tagged as a bill item;
   *  - a copy of a row already saved in history/ (same id, or the same
   *    date/type/amount — the old parser mis-split refunded purchases) —
   *    dropped, the history copy wins;
   *  - otherwise a history row — moved to history/ (rows in shard M are
   *    dated in M, so they go to history/M).
   *
   * Runs MIGRATE_BATCH months per call, from `from` on, without reconciling;
   * `next` is where the following call resumes (null when done). Call
   * {@link relink} afterwards. `dryRun` reports every month without writing.
   */
  async migrate(dryRun: boolean, from?: string): Promise<MigrationReport> {
    const meta = await this.getMeta();
    const report: MigrationReport = { dryRun, movedToHistory: 0, taggedAsBill: 0, dropped: 0, byMonth: {}, next: null };
    const todo = meta.months.filter((m) => !from || m >= from);
    const batch = dryRun ? todo : todo.slice(0, MIGRATE_BATCH);
    report.next = todo[batch.length] ?? null;

    const emptied: string[] = [];
    const historyTouched: string[] = [];
    for (const month of batch) {
      const [billFile, histFile] = await Promise.all([
        this.koofr.getJson<Transaction[]>(this.#path("bill", month)),
        meta.historyMonths.includes(month)
          ? this.koofr.getJson<Transaction[]>(this.#path("history", month))
          : Promise.resolve(null),
      ]);
      const shard = billFile?.data ?? [];
      const history = histFile?.data ?? [];
      const { tag, drop, move } = planMigration(shard, history, month);
      if (!tag.length && !drop.length && !move.length) continue;
      report.byMonth[month] = { movedToHistory: move.length, taggedAsBill: tag.length, dropped: drop.length };
      report.movedToHistory += move.length;
      report.taggedAsBill += tag.length;
      report.dropped += drop.length;
      if (dryRun) continue;

      for (const t of tag) {
        t.statement = month;
        const p = t.description.match(/^\[(\d+)\/(\d+)\]/);
        if (p) Object.assign(t, { part: Number(p[1]), of: Number(p[2]) });
        delete t.txnDate;
        delete t.ref;
      }
      // History first: if the bill write then fails, a rerun drops the
      // already-moved rows as copies instead of losing them.
      if (move.length) {
        for (const t of move) {
          delete t.billedIn;
          delete t.txnDate;
          delete t.ref;
        }
        const merged = [...history, ...move].sort((a, b) => a.date.localeCompare(b.date));
        await this.koofr.putJson(this.#path("history", month), merged, histFile?.etag);
        historyTouched.push(month);
      }
      const kept = shard.filter((t) => t.statement);
      if (kept.length) await this.koofr.putJson(this.#path("bill", month), kept, billFile?.etag);
      else {
        await this.koofr.delete(this.#path("bill", month));
        emptied.push(month);
      }
    }

    if (historyTouched.length || emptied.length) {
      await this.#updateJson<Meta>("meta.json", EMPTY_META, (m) => ({
        ...EMPTY_META,
        ...m,
        months: m.months.filter((x) => !emptied.includes(x)),
        historyMonths: [...new Set([...(m.historyMonths ?? []), ...historyTouched])].sort(),
        lastSync: new Date().toISOString(),
      }));
    }
    return report;
  }

  /** Re-run bill ↔ history reconciliation around every stored bill month. */
  async relink(): Promise<{ billItems: number; dated: number }> {
    const meta = await this.getMeta();
    if (!meta.months.length) return { billItems: 0, dated: 0 };
    let bills: Transaction[] = [];
    await this.#withWindow(meta.months, (shards) => {
      // Reconciliation then updates these stored objects in place.
      bills = [...shards.values()].filter((s) => s.kind === "bill").flatMap((s) => s.txns);
    });
    return { billItems: bills.length, dated: bills.filter((t) => t.txnDate).length };
  }

  /** Full dump for backup. */
  async exportAll(): Promise<{
    meta: Meta;
    transactions: Record<string, Transaction[]>;
    history: Record<string, Transaction[]>;
  }> {
    const meta = await this.getMeta();
    const transactions: Record<string, Transaction[]> = {};
    for (const month of meta.months) transactions[month] = await this.getShard("bill", month);
    const history: Record<string, Transaction[]> = {};
    for (const month of meta.historyMonths) history[month] = await this.getShard("history", month);
    return { meta, transactions, history };
  }
}
