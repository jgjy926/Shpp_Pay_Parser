// Transaction store on top of Koofr — monthly shards + meta.json (SPEC.md §2).

import { KoofrClient, KoofrConflictError, type KoofrFile } from "./koofr";
import { EMPTY_META, type IncomingTransaction, type Meta, type Transaction } from "./types";
import { reconcile } from "../../web/reconcile.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Months to read either side of the touched ones when reconciling: covers a
 *  12-part instalment plan bought up to a year before the bill that bills it. */
const WINDOW_MONTHS = 12;

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

interface Shard {
  etag: string | null;
  before: string; // serialized as read, to skip unchanged writes
  txns: Transaction[];
}

const isCharge = (t: Transaction) => t.type === "BNPL" || t.type === "Instalment";

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
  count: number;
  charges: number; // BNPL + Instalment, excluding history already counted via a bill
  billed: number; // ...of which on this month's statement
  pending: number; // ...of which from history, not yet on any statement
  payments: number; // Bill Payment
  refunds: number;
  net: number; // charges - payments - refunds
  byType: Record<string, { count: number; total: number }>;
  topMerchants: { merchant: string; total: number; count: number }[];
}

export class Store {
  constructor(private koofr: KoofrClient) {}

  #monthPath(month: string): string {
    return `transactions/${month}.json`;
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
    return file?.data ?? EMPTY_META;
  }

  async getMonth(month: string): Promise<Transaction[]> {
    const file = await this.koofr.getJson<Transaction[]>(this.#monthPath(month));
    return file?.data ?? [];
  }

  /**
   * Load every existing shard within WINDOW_MONTHS of `touched`, let `mutate`
   * edit them, re-run bill↔history reconciliation over the lot, then write
   * back only the shards that changed. Retries once on an ETag conflict.
   */
  async #withWindow<R>(touched: string[], mutate: (shards: Map<string, Shard>) => R): Promise<R> {
    const sorted = [...touched].sort();
    const lo = shiftMonth(sorted[0], -WINDOW_MONTHS);
    const hi = shiftMonth(sorted[sorted.length - 1], WINDOW_MONTHS);
    const latestTouched = sorted[sorted.length - 1];

    for (let attempt = 0; ; attempt++) {
      const meta = await this.getMeta();
      const months = [...new Set([...meta.months.filter((m) => m >= lo && m <= hi), ...touched])];
      const files = await Promise.all(
        months.map((m) => this.koofr.getJson<Transaction[]>(this.#monthPath(m))),
      );
      const shards = new Map<string, Shard>();
      months.forEach((m, i) => {
        const f: KoofrFile<Transaction[]> | null = files[i];
        const before = JSON.stringify(f?.data ?? []);
        shards.set(m, { etag: f?.etag ?? null, before, txns: JSON.parse(before) });
      });

      const result = mutate(shards);

      const all = [...shards.values()].flatMap((s) => s.txns);
      const { pairs, billedIn } = reconcile(all);
      for (const t of all) {
        if (t.statement) {
          const h = pairs.get(t) as Transaction | undefined;
          if (h) {
            t.txnDate = h.date;
            t.ref = h.id;
          }
        } else {
          const s = billedIn.get(t);
          if (s) t.billedIn = s;
          // Clear only where every statement that could claim this record
          // (up to WINDOW_MONTHS later) was loaded.
          else if (t.date.slice(0, 7) <= latestTouched) delete t.billedIn;
        }
      }

      try {
        for (const [m, s] of shards) {
          s.txns.sort((a, b) => a.date.localeCompare(b.date));
          if (JSON.stringify(s.txns) === s.before) continue;
          await this.koofr.putJson(this.#monthPath(m), s.txns, s.etag);
        }
      } catch (e) {
        if (!(e instanceof KoofrConflictError) || attempt >= 1) throw e;
        continue;
      }
      return result;
    }
  }

  /** Bulk upsert: shard by month, dedupe by deterministic id, then reconcile. */
  async upsert(
    incoming: IncomingTransaction[],
  ): Promise<{ added: number; skipped: number; billItems: number; dated: number }> {
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
    const prepared: Transaction[] = await Promise.all(
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

    const byMonth = new Map<string, Transaction[]>();
    for (const t of prepared) {
      const month = t.date.slice(0, 7);
      byMonth.set(month, [...(byMonth.get(month) ?? []), t]);
    }

    const { added, skipped, bills } = await this.#withWindow([...byMonth.keys()], (shards) => {
      let added = 0;
      let skipped = 0;
      const bills = new Set<Transaction>(); // stored copies of this import's bill items
      for (const [month, txns] of byMonth) {
        const shard = shards.get(month)!;
        const existing = new Map(shard.txns.map((t) => [t.id, t]));
        for (const t of txns) {
          const old = existing.get(t.id);
          if (t.statement) bills.add(old ?? t);
          if (!old) {
            shard.txns.push(t);
            existing.set(t.id, t); // also dedupes within the batch itself
            added++;
            continue;
          }
          skipped++;
          // Re-importing a bill stored before bill items were tagged upgrades
          // it in place (same id, since `date` is the statement's last day).
          if (t.statement && !old.statement) {
            old.statement = t.statement;
            if (t.part && t.of) Object.assign(old, { part: t.part, of: t.of });
          }
        }
      }
      return { added, skipped, bills };
    });

    await this.#updateJson<Meta>("meta.json", EMPTY_META, (meta) => ({
      ...meta,
      months: [...new Set([...meta.months, ...byMonth.keys()])].sort(),
      lastSync: importedAt,
    }));

    // Reconciliation mutated the stored objects in place, so these now carry
    // txnDate wherever a dated history record was found.
    const dated = [...bills].filter((t) => t.txnDate).length;
    return { added, skipped, billItems: bills.size, dated };
  }

  /** Returns true if the transaction existed and was removed. Re-reconciles,
   *  so deleting a bill item returns its history record to pending. */
  async deleteTransaction(month: string, id: string): Promise<boolean> {
    return this.#withWindow([month], (shards) => {
      const shard = shards.get(month)!;
      const before = shard.txns.length;
      shard.txns = shard.txns.filter((t) => t.id !== id);
      return shard.txns.length < before;
    });
  }

  async summary(month: string): Promise<MonthSummary> {
    // History already claimed by a statement is counted via its bill item.
    const txns = (await this.getMonth(month)).filter((t) => !t.billedIn);

    const byType: MonthSummary["byType"] = {};
    const merchants = new Map<string, { total: number; count: number }>();
    for (const t of txns) {
      byType[t.type] ??= { count: 0, total: 0 };
      byType[t.type].count++;
      byType[t.type].total = round2(byType[t.type].total + t.amount);

      if (t.type === "BNPL" || t.type === "Instalment") {
        const m = merchants.get(t.merchant) ?? { total: 0, count: 0 };
        m.total = round2(m.total + t.amount);
        m.count++;
        merchants.set(t.merchant, m);
      }
    }

    const charges = round2((byType["BNPL"]?.total ?? 0) + (byType["Instalment"]?.total ?? 0));
    const payments = byType["Bill Payment"]?.total ?? 0;
    const refunds = byType["Refund"]?.total ?? 0;

    const billed = round2(txns.filter((t) => isCharge(t) && t.statement).reduce((a, t) => a + t.amount, 0));

    return {
      month,
      count: txns.length,
      charges,
      billed,
      pending: round2(charges - billed),
      payments,
      refunds,
      net: round2(charges - payments - refunds),
      byType,
      topMerchants: [...merchants.entries()]
        .map(([merchant, v]) => ({ merchant, ...v }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 5),
    };
  }

  /** Full dump for backup. */
  async exportAll(): Promise<{ meta: Meta; transactions: Record<string, Transaction[]> }> {
    const meta = await this.getMeta();
    const transactions: Record<string, Transaction[]> = {};
    for (const month of meta.months) {
      transactions[month] = await this.getMonth(month);
    }
    return { meta, transactions };
  }
}
