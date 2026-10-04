// Bill ↔ history reconciliation.
//
// ShopeePay shows the same spending two ways, each missing half the picture:
//   - the monthly BILL (grouped statement) — authoritative for what is charged
//     in a statement month, incl. instalment parts "[k/n]", but has no dates;
//   - the transaction HISTORY — every purchase with its real date, but an
//     instalment appears once at its full plan amount, and recent purchases
//     may not have been billed yet.
// `reconcile` pairs each bill item with the dated history record it came from,
// so the bill item can be enriched with the real purchase date and the history
// record marked as billed (counted via the bill instead of on its own).
//
// Pure ES module with no DOM — shared by the browser preview and the Worker
// (which runs it over stored + incoming records), and testable under node.

const ONE_DAY = 86_400_000;
const PART_PREFIX = /^\[\d+\/\d+\]\s*/;
// Promo tags ShopeePay injects into history titles but not bill lines, e.g.
// "Zenlush『9.25 Big Sale』Soft Bantal…".
const PROMO_TAG = /[『【][^』】]*[』】]/g;

/** Description reduced to lowercase letters/digits, minus [k/n] and promo tags. */
export function normalizeDesc(s) {
  return s
    .replace(PART_PREFIX, "")
    .replace(PROMO_TAG, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Same item if equal, or one is a prefix of the other (titles get truncated
 *  or suffixed differently between the two views). */
export function sameItem(a, b) {
  const x = normalizeDesc(a);
  const y = normalizeDesc(b);
  if (x === y) return x.length > 0;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 20 && long.startsWith(short);
}

const cents = (n) => Math.round(n * 100);

const monthIndex = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;

function periodOf(statement) {
  const [y, m] = statement.split("-").map(Number);
  return { start: Date.UTC(y, m - 1, 1), end: Date.UTC(y, m, 0) };
}

const dayMs = (iso) => Date.parse(`${iso}T00:00:00Z`);

const isBill = (r) => typeof r.statement === "string";
const isHistoryCharge = (r) =>
  !isBill(r) && (r.type === "BNPL" || r.type === "Instalment" || r.type === "Refund");

// A BNPL purchase normally lands on the bill of the month it was made, but
// online orders can bill a month or two later.
const LOOKBACK_DAYS = 62;

/**
 * Pair bill items with history records.
 *
 * `records` is any mix of bill items (`statement` set; `part`/`of` for
 * instalments; `ref` once previously paired) and history records (no
 * `statement`). Objects are matched by identity; nothing is mutated.
 *
 * Rules:
 *  - BNPL / Refund bill item ↔ history record of the same type, same amount to
 *    the cent, same item, dated within the statement period or up to
 *    LOOKBACK_DAYS before it. One history record per bill item. Prefers an
 *    in-period record, then the earliest.
 *  - Instalment part [k/n] ↔ history plan record whose amount ≈ part × n
 *    (±1 sen per part for rounding), same item, dated on/before the period
 *    end. A plan is shared by its parts across statements, but each part
 *    number claims a plan once. A later part first follows an earlier,
 *    already-paired part of the same plan.
 *  - An existing `ref` that still resolves is kept as-is.
 *
 * Returns { pairs: Map<bill, history>, billedIn: Map<history, "YYYY-MM"> }
 * where billedIn is the earliest statement that claimed each history record.
 */
export function reconcile(records) {
  const bills = records.filter(isBill);
  const history = records.filter(isHistoryCharge).sort((a, b) => a.date.localeCompare(b.date));
  const byId = new Map(history.filter((h) => h.id).map((h) => [h.id, h]));

  const pairs = new Map();
  const claimedOnce = new Set(); // BNPL/Refund history: one bill item each
  const partClaims = new Map(); // instalment plan -> Set of claimed part numbers

  const claim = (bill, h) => {
    pairs.set(bill, h);
    if (bill.part) {
      if (!partClaims.has(h)) partClaims.set(h, new Set());
      partClaims.get(h).add(bill.part);
    } else {
      claimedOnce.add(h);
    }
  };

  for (const b of bills) {
    const h = b.ref && byId.get(b.ref);
    if (h) claim(b, h);
  }

  const pending = bills
    .filter((b) => !pairs.has(b))
    .sort((a, b) => a.statement.localeCompare(b.statement) || (a.part ?? 0) - (b.part ?? 0));

  for (const b of pending) {
    const { start, end } = periodOf(b.statement);
    let match = null;

    if (b.type === "Instalment" && b.part && b.of) {
      // Follow an earlier part of the same plan, e.g. [1/3] in Aug → [2/3] in Sep.
      for (const [prev, h] of pairs) {
        if (
          prev.type === "Instalment" &&
          prev.of === b.of &&
          prev.part < b.part &&
          monthIndex(b.statement) - monthIndex(prev.statement) === b.part - prev.part &&
          Math.abs(cents(prev.amount) - cents(b.amount)) <= 2 &&
          !partClaims.get(h)?.has(b.part) &&
          sameItem(prev.description, b.description)
        ) {
          match = h;
          break;
        }
      }
      match ??= history.find(
        (h) =>
          h.type === "Instalment" &&
          Math.abs(cents(h.amount) - cents(b.amount) * b.of) <= b.of &&
          dayMs(h.date) <= end &&
          !partClaims.get(h)?.has(b.part) &&
          sameItem(h.description, b.description),
      );
    } else {
      const candidates = history.filter(
        (h) =>
          h.type === b.type &&
          !claimedOnce.has(h) &&
          !partClaims.has(h) &&
          cents(h.amount) === cents(b.amount) &&
          dayMs(h.date) <= end &&
          dayMs(h.date) >= start - LOOKBACK_DAYS * ONE_DAY &&
          !PART_PREFIX.test(h.description) &&
          sameItem(h.description, b.description),
      );
      match = candidates.find((h) => dayMs(h.date) >= start) ?? candidates[0] ?? null;
    }

    if (match) claim(b, match);
  }

  const billedIn = new Map();
  for (const [b, h] of pairs) {
    const cur = billedIn.get(h);
    if (!cur || b.statement < cur) billedIn.set(h, b.statement);
  }
  return { pairs, billedIn };
}
