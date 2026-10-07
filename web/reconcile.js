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
// online orders can bill a month or two later. In-store payments are charged
// at the till, so they bill in the purchase month (a day's grace for
// late-night payments) — otherwise last month's regular RM10 shop visit would
// be taken for this month's.
const LOOKBACK_DAYS = 62;
const IN_STORE_LOOKBACK_DAYS = 1;
const IN_STORE = /^In Store - /i;

/** Statement-period window a BNPL/Refund purchase may fall in for bill item `b`. */
function chargeWindow(b) {
  const { start, end } = periodOf(b.statement);
  const days = IN_STORE.test(b.description) ? IN_STORE_LOOKBACK_DAYS : LOOKBACK_DAYS;
  return { start, end, earliest: start - days * ONE_DAY };
}

/** Could history record `h` be the purchase behind BNPL/Refund bill item `b`? */
function fitsCharge(b, h) {
  const { end, earliest } = chargeWindow(b);
  return (
    h.type === b.type &&
    cents(h.amount) === cents(b.amount) &&
    dayMs(h.date) <= end &&
    dayMs(h.date) >= earliest &&
    !PART_PREFIX.test(h.description) &&
    sameItem(h.description, b.description)
  );
}

/** Sen a part may differ from plan ÷ n: ±1 for rounding, but the last part
 *  absorbs the remainder of the others (e.g. 19.63 × 5 then 19.66). */
const partTolerance = (b) => (b.part === b.of ? b.of : 1);

/** Months between plan `h`'s purchase and the month part 1 of `b` billed. */
const planLag = (b, h) => monthIndex(b.statement) - monthIndex(h.date) - (b.part - 1);

/** Could instalment plan `h` be the plan behind part [k/n] bill item `b`?
 *  Part k bills k-1 months after the first part, which bills in the purchase
 *  month or the one after — so the plan was bought 0–1 months before
 *  statement − (k−1). */
function fitsPlan(b, h) {
  const lag = planLag(b, h);
  return (
    h.type === "Instalment" &&
    Math.abs(cents(h.amount) - cents(b.amount) * b.of) <= partTolerance(b) * b.of &&
    dayMs(h.date) <= periodOf(b.statement).end &&
    (lag === 0 || lag === 1) &&
    sameItem(h.description, b.description)
  );
}

const isPartItem = (b) => b.type === "Instalment" && b.part && b.of;

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
 *    LOOKBACK_DAYS before it (IN_STORE_LOOKBACK_DAYS for in-store payments).
 *    One history record per bill item. Prefers an in-period record, then the
 *    earliest.
 *  - Instalment part [k/n] ↔ history plan record whose amount ≈ part × n
 *    (±1 sen per part for rounding), same item, bought 0–1 months before
 *    statement − (k−1) (closest first). A plan is shared by its parts across
 *    statements, but each part number claims a plan once. A later part first
 *    follows an earlier, already-paired part of the same plan.
 *  - An existing `ref` is kept while it resolves and still fits these rules.
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
  const free = (b, h) => (b.part ? !partClaims.get(h)?.has(b.part) : !claimedOnce.has(h) && !partClaims.has(h));

  for (const b of bills) {
    const h = b.ref && byId.get(b.ref);
    if (h && (isPartItem(b) ? fitsPlan(b, h) : fitsCharge(b, h)) && free(b, h)) claim(b, h);
  }

  const pending = bills
    .filter((b) => !pairs.has(b))
    .sort((a, b) => a.statement.localeCompare(b.statement) || (a.part ?? 0) - (b.part ?? 0));

  for (const b of pending) {
    let match = null;

    if (isPartItem(b)) {
      // Follow an earlier part of the same plan, e.g. [1/3] in Aug → [2/3] in Sep.
      for (const [prev, h] of pairs) {
        if (
          prev.type === "Instalment" &&
          prev.of === b.of &&
          prev.part < b.part &&
          monthIndex(b.statement) - monthIndex(prev.statement) === b.part - prev.part &&
          Math.abs(cents(prev.amount) - cents(b.amount)) <= Math.max(2, partTolerance(b)) &&
          free(b, h) &&
          sameItem(prev.description, b.description)
        ) {
          match = h;
          break;
        }
      }
      // Repeat purchases of the same item/amount in other months (a regular
      // RM270 shop visit) must not steal the match.
      match ??=
        history
          .filter((h) => fitsPlan(b, h) && free(b, h))
          .sort((x, y) => planLag(b, x) - planLag(b, y))[0] ?? null;
    } else {
      const { start } = chargeWindow(b);
      const candidates = history.filter((h) => fitsCharge(b, h) && free(b, h));
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
