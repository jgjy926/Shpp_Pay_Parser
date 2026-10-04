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

  // Bill items (grouped statement) — `date` is the statement's last day, which
  // keeps the id stable when the item is later enriched from history.
  statement?: string; // YYYY-MM billing month
  part?: number; // instalment "[part/of]"
  of?: number;
  txnDate?: string; // real purchase date, from the matched history record
  ref?: string; // id of the matched history record

  // History charges (BNPL / Instalment plan / Refund, no `statement`) — set
  // once a bill item claims this record; it is then counted via the bill.
  billedIn?: string; // YYYY-MM of the earliest claiming statement
}

/** What clients POST — id/merchant/channel/importedAt are derived if absent;
 *  txnDate/ref/billedIn are always derived server-side by reconciliation. */
export interface IncomingTransaction {
  date: string;
  type: TxType;
  description: string;
  sign: "+" | "-";
  amount: number;
  merchant?: string;
  channel?: "in_store" | "online";
  statement?: string;
  part?: number;
  of?: number;
}

export interface Meta {
  schemaVersion: 1;
  months: string[]; // sorted ascending, e.g. ["2026-05", "2026-06"]
  lastSync: string | null;
}

export const EMPTY_META: Meta = { schemaVersion: 1, months: [], lastSync: null };
