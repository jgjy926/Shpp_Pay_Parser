// Data model — see SPEC.md §2.

export const TX_TYPES = ["BNPL", "Instalment", "Bill Payment", "Refund"] as const;
export type TxType = (typeof TX_TYPES)[number];

export interface Transaction {
  id: string; // sha1(date|type|desc|amount) — computed server-side
  date: string; // YYYY-MM-DD
  type: TxType;
  description: string;
  merchant: string;
  channel: "in_store" | "online";
  sign: "+" | "-";
  amount: number; // always positive, 2dp
  currency: "MYR";
  importedAt: string; // ISO timestamp
}

/** What clients POST — id/merchant/channel/importedAt are derived if absent. */
export interface IncomingTransaction {
  date: string;
  type: TxType;
  description: string;
  sign: "+" | "-";
  amount: number;
  merchant?: string;
  channel?: "in_store" | "online";
}

export interface Meta {
  schemaVersion: 1;
  months: string[]; // sorted ascending, e.g. ["2026-05", "2026-06"]
  lastSync: string | null;
}

export const EMPTY_META: Meta = { schemaVersion: 1, months: [], lastSync: null };
