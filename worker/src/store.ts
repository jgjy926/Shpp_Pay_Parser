// Transaction store on top of Koofr — monthly shards + meta.json (SPEC.md §2).

import { KoofrClient, KoofrConflictError } from "./koofr";
import { EMPTY_META, type IncomingTransaction, type Meta, type Transaction } from "./types";

const round2 = (n: number) => Math.round(n * 100) / 100;

async function sha1Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic id — dedupe relies on this exact recipe (amount fixed to 2dp). */
export function idInput(t: IncomingTransaction): string {
  return `${t.date}|${t.type}|${t.description}|${t.amount.toFixed(2)}`;
}

/** `In Store - X` → merchant X / in_store; anything else is an online purchase. */
function deriveMerchant(description: string): { merchant: string; channel: "in_store" | "online" } {
  const m = description.match(/^In Store - (.+)$/i);
  return m
    ? { merchant: m[1].trim(), channel: "in_store" }
    : { merchant: description.trim(), channel: "online" };
}

export interface MonthSummary {
  month: string;
  count: number;
  charges: number; // BNPL + Instalment
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

  /** Bulk upsert: shard by month, dedupe by deterministic id. */
  async upsert(incoming: IncomingTransaction[]): Promise<{ added: number; skipped: number }> {
    const importedAt = new Date().toISOString();
    const prepared: Transaction[] = await Promise.all(
      incoming.map(async (t) => ({
        id: await sha1Hex(idInput(t)),
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
      })),
    );

    const byMonth = new Map<string, Transaction[]>();
    for (const t of prepared) {
      const month = t.date.slice(0, 7);
      byMonth.set(month, [...(byMonth.get(month) ?? []), t]);
    }

    let added = 0;
    let skipped = 0;
    for (const [month, txns] of byMonth) {
      await this.#updateJson<Transaction[]>(this.#monthPath(month), [], (current) => {
        const ids = new Set(current.map((t) => t.id));
        const fresh = txns.filter((t) => {
          if (ids.has(t.id)) return false;
          ids.add(t.id); // also dedupes within the batch itself
          return true;
        });
        added += fresh.length;
        skipped += txns.length - fresh.length;
        return [...current, ...fresh].sort((a, b) => a.date.localeCompare(b.date));
      });
    }

    await this.#updateJson<Meta>("meta.json", EMPTY_META, (meta) => ({
      ...meta,
      months: [...new Set([...meta.months, ...byMonth.keys()])].sort(),
      lastSync: importedAt,
    }));

    return { added, skipped };
  }

  /** Returns true if the transaction existed and was removed. */
  async deleteTransaction(month: string, id: string): Promise<boolean> {
    let found = false;
    await this.#updateJson<Transaction[]>(this.#monthPath(month), [], (current) => {
      const next = current.filter((t) => t.id !== id);
      found = next.length < current.length;
      return next;
    });
    return found;
  }

  async summary(month: string): Promise<MonthSummary> {
    const txns = await this.getMonth(month);

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

    return {
      month,
      count: txns.length,
      charges,
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
