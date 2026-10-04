import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShopeePay } from "../web/parser.js";
import { reconcile, sameItem } from "../web/reconcile.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => readFileSync(join(fixturesDir, name), "utf8");
const today = new Date(2026, 9, 5); // 5 Oct 2026, when the Sep fixtures were captured

test("synthetic fixture parses fully", () => {
  const text = readFileSync(join(fixturesDir, "synthetic.txt"), "utf8");
  const { transactions, errors } = parseShopeePay(text);

  assert.deepEqual(errors, []);
  assert.equal(transactions.length, 5);

  assert.deepEqual(transactions[0], {
    date: "2026-05-29",
    type: "BNPL",
    description: "In Store - THONG 1964 ENTERPRISE",
    sign: "-",
    amount: 10.0,
  });

  // Comma-grouped amount
  assert.equal(transactions[1].amount, 1132.32);
  // Refund keeps its + sign
  assert.equal(transactions[3].sign, "+");
  // Record with no description line falls back to the type
  assert.deepEqual(transactions[4], {
    date: "2026-05-02",
    type: "BNPL",
    description: "BNPL",
    sign: "-",
    amount: 23.45,
  });
});

test("multi-line descriptions are joined", () => {
  const { transactions, errors } = parseShopeePay(
    "Instalment\nApple iPhone 17\n256GB Blue\n01 Jun 2026\n-RM4,299.00\n",
  );
  assert.deepEqual(errors, []);
  assert.equal(transactions[0].description, "Apple iPhone 17 256GB Blue");
});

test("app chrome around records is ignored, not an error", () => {
  const { transactions, errors, ignored } = parseShopeePay(
    "All Transactions\nBNPL\nShop A\n03 May 2026\n-RM5.00\nSplit into Instalments\n",
  );
  assert.equal(transactions.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    ignored.map((g) => g.line),
    [1, 6],
  );
});

test("incomplete trailing record is an error", () => {
  const { transactions, errors } = parseShopeePay("BNPL\nShop B\n");
  assert.equal(transactions.length, 0);
  assert.equal(errors.length, 1);
});

test("date without amount is an error, next record still parses", () => {
  const { transactions, errors } = parseShopeePay(
    "BNPL\nShop C\n04 May 2026\nnot-an-amount\nRefund\nShop C\n05 May 2026\n+RM1.00\n",
  );
  assert.equal(errors.length, 1);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].type, "Refund");
});

// ---- Grouped statement format (newer ShopeePay monthly-statement view) ----

test("grouped: type is a section header spanning many dateless items", () => {
  const { transactions, errors, ignored } = parseShopeePay(
    [
      "Total 2 transactions",
      "01 Aug - 31 Aug",
      "Due Date 10 Sep 2026",
      "",
      "BNPL",
      "In Store - SHOP A",
      "RM20.00",
      "",
      "Cool Gadget",
      "RM5.50",
    ].join("\n"),
  );
  assert.deepEqual(errors, []);
  assert.equal(transactions.length, 2);
  // No per-item date: both inherit the statement month (last day), sign charge.
  assert.deepEqual(transactions[0], {
    date: "2026-08-31",
    type: "BNPL",
    description: "In Store - SHOP A",
    sign: "-",
    amount: 20.0,
    statement: "2026-08",
  });
  assert.equal(transactions[1].description, "Cool Gadget");
  assert.equal(transactions[1].amount, 5.5);
  // The summary header lines are chrome, not errors.
  assert.ok(ignored.some((g) => g.text.startsWith("Total")));
});

test("grouped: statement year rolls back when period precedes its due month", () => {
  const { transactions } = parseShopeePay(
    ["Due Date 10 Jan 2026", "01 Dec - 31 Dec", "", "BNPL", "Shop", "RM1.00"].join("\n"),
  );
  assert.equal(transactions[0].date, "2025-12-31");
});

test("grouped: declared total that disagrees with the parse is surfaced", () => {
  const { transactions, errors } = parseShopeePay(
    ["Total 5 transactions", "01 Aug - 31 Aug", "Due Date 10 Sep 2026", "", "BNPL", "Shop", "RM1.00"].join("\n"),
  );
  assert.equal(transactions.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /declares 5 transactions but 1/);
});

// Real export — the format that broke the old parser ("BNPL record never
// completed"). Its own header cross-checks the parse: Bill Amount RM2,501.49
// and "Total 83 transactions".
test("aug-2026 grouped statement parses 100% and preserves duplicates", () => {
  const text = readFileSync(join(fixturesDir, "aug-2026-grouped.txt"), "utf8");
  const { transactions, errors } = parseShopeePay(text);

  assert.deepEqual(errors, []);
  assert.equal(transactions.length, 83);

  const count = (type) => transactions.filter((t) => t.type === type).length;
  const sum = (type) =>
    Math.round(transactions.filter((t) => t.type === type).reduce((a, t) => a + t.amount, 0) * 100) / 100;

  assert.equal(count("BNPL"), 56);
  assert.equal(count("Instalment"), 27);
  assert.equal(sum("BNPL"), 1776.43);
  assert.equal(sum("Instalment"), 725.06);
  // Matches the statement's own "Bill Amount + RM2,501.49".
  assert.equal(Math.round((sum("BNPL") + sum("Instalment")) * 100) / 100, 2501.49);

  // Every item inherits the statement month (last day); sign defaults to charge.
  assert.ok(transactions.every((t) => t.date === "2026-08-31" && t.sign === "-"));

  // Genuine duplicates (same merchant + amount, different days) must survive —
  // the parser emits all four RM10.50 fishball runs, not a deduped one.
  const fishball1050 = transactions.filter(
    (t) => t.description === "In Store - K.L. SEREMBAN FISHBALL" && t.amount === 10.5,
  );
  assert.equal(fishball1050.length, 4);
});

// Real export — Phase 3 acceptance: 100% of May 2026 records parse with zero errors.
test("may-2026 real fixture parses 100%", () => {
  const text = readFileSync(join(fixturesDir, "may-2026.txt"), "utf8");
  const { transactions, errors, ignored } = parseShopeePay(text);

  assert.deepEqual(errors, []);
  assert.equal(transactions.length, 58);
  // Only app chrome is ignored: 3 header lines + 2 footer lines.
  assert.deepEqual(ignored.map((g) => g.line), [1, 2, 3, 345, 346]);

  const sum = (type) =>
    Math.round(transactions.filter((t) => t.type === type).reduce((a, t) => a + t.amount, 0) * 100) / 100;
  const count = (type) => transactions.filter((t) => t.type === type).length;

  assert.equal(count("BNPL"), 38);
  assert.equal(sum("BNPL"), 976.6);
  assert.equal(count("Instalment"), 13);
  assert.equal(sum("Instalment"), 1464.3);
  assert.equal(count("Bill Payment"), 6);
  assert.equal(sum("Bill Payment"), 2791.06);
  assert.equal(count("Refund"), 1);
  assert.equal(sum("Refund"), 7.5);

  // Description-less records fall back to the type name.
  assert.ok(transactions.filter((t) => t.type === "Bill Payment").every((t) => t.description === "Bill Payment"));
  // Spot-check: space after sign + comma amount.
  const big = transactions.find((t) => t.amount === 1132.32);
  assert.deepEqual(big, {
    date: "2026-05-02",
    type: "Bill Payment",
    description: "Bill Payment",
    sign: "-",
    amount: 1132.32,
  });
});

// ---- Sep 2026: paid-in-full bill + transaction history (bill↔history merge) ----

// A fully paid bill drops the "Due Date DD Mon YYYY" line, so the header has
// no year at all — previously every item failed with "could not determine
// statement month".
test("sep-2026 paid-in-full bill parses without a due date", () => {
  const { transactions, errors } = parseShopeePay(fixture("sep-2026-bill.txt"), { today });
  assert.deepEqual(errors, []); // also passes the Bill Amount RM1,209.98 cross-check
  assert.equal(transactions.length, 44);
  assert.ok(transactions.every((t) => t.date === "2026-09-30" && t.statement === "2026-09"));

  const parts = transactions.filter((t) => t.part);
  assert.equal(parts.length, 28);
  assert.deepEqual(
    transactions.find((t) => t.description.startsWith("[5/6] REMDII")),
    {
      date: "2026-09-30",
      type: "Instalment",
      description: "[5/6] REMDII ULTRA SENSITIVE DAILY ADVANCE INT BARRIER REPAIR CREAM 150ML 2S",
      sign: "-",
      amount: 33.85,
      statement: "2026-09",
      part: 5,
      of: 6,
    },
  );
});

test("yearless statement month never lands in the future", () => {
  const text = ["Total 1 transactions", "01 Dec - 31 Dec", "", "BNPL", "Shop", "RM1.00"].join("\n");
  const { transactions } = parseShopeePay(text, { today: new Date(2027, 0, 3) });
  assert.equal(transactions[0].date, "2026-12-31");
});

test("Bill Amount that disagrees with the parsed items is surfaced", () => {
  const text = ["Bill Amount", "+ RM9.00", "01 Aug - 31 Aug", "Due Date 10 Sep 2026", "BNPL", "Shop", "RM1.00"].join("\n");
  const { errors } = parseShopeePay(text);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Bill Amount is RM9.00 but parsed items total RM1.00/);
});

test("sep-2026 history: filter tabs are chrome, unsigned amounts default by type", () => {
  const { transactions, errors, ignored } = parseShopeePay(fixture("sep-2026-history.txt"));
  assert.deepEqual(errors, []);
  assert.equal(transactions.length, 25);
  // "All / Checkout / Bill Payment / Refund / Sep / 2026" + footer
  assert.deepEqual(ignored.map((g) => g.line), [1, 2, 3, 4, 5, 6, 129]);
  const payments = transactions.filter((t) => t.type === "Bill Payment");
  assert.deepEqual(payments.map((t) => [t.date, t.amount]), [
    ["2026-09-19", 290.01],
    ["2026-09-06", 488.47],
    ["2026-09-02", 1200.55],
  ]);
  assert.ok(transactions.every((t) => t.sign === "-" && !t.statement));
});

for (const [name, join] of [
  ["bill then history", (b, h) => `${b}\n+++\n${h}`],
  ["history then bill", (b, h) => `${h}\n\n++++\n\n${b}`],
]) {
  test(`bill + history pasted together (${name}) both parse`, () => {
    const { transactions, errors } = parseShopeePay(
      join(fixture("sep-2026-bill.txt"), fixture("sep-2026-history.txt")),
      { today },
    );
    assert.deepEqual(errors, []);
    assert.equal(transactions.filter((t) => t.statement).length, 44);
    assert.equal(transactions.filter((t) => !t.statement).length, 25);
  });
}

test("reconcile: Sep bill items get dates from Sep history", () => {
  const { transactions } = parseShopeePay(
    `${fixture("sep-2026-bill.txt")}\n+++\n${fixture("sep-2026-history.txt")}`,
    { today },
  );
  const { pairs, billedIn } = reconcile(transactions);
  const dateOf = (prefix, amount) => {
    const b = transactions.find((t) => t.statement && t.description.startsWith(prefix) && t.amount === amount);
    return pairs.get(b)?.date ?? null;
  };

  // 14 BNPL + 4 first instalment parts are bought within Sep.
  assert.equal(pairs.size, 18);
  assert.equal(billedIn.size, 18);
  // Same merchant, different amounts → different days.
  assert.equal(dateOf("In Store - GREENS FRESH GROCERY", 8), "2026-09-29");
  assert.equal(dateOf("In Store - GREENS FRESH GROCERY", 6.5), "2026-09-25");
  // Instalment part ↔ plan total: 23.00 / 3 → 7.66 (rounding tolerated).
  assert.equal(dateOf("[1/3] [Hydration] St. Ives", 7.66), "2026-09-09");
  assert.equal(dateOf("[1/3] In Store - GOH JIAN YU", 90), "2026-09-06");
  // [2/3] GOH JIAN YU RM95 is a different (Aug) plan, not the Sep RM270 one.
  assert.equal(dateOf("[2/3] In Store - GOH JIAN YU", 95), null);
  // Online orders from an earlier month stay undated without that history.
  assert.equal(dateOf("Hot Sale Cartoon Mask", 13.79), null);

  // Late-Sep purchases are not on the Sep bill — they belong to October's.
  const unbilled = transactions
    .filter((t) => !t.statement && t.type !== "Bill Payment" && !billedIn.has(t))
    .map((t) => [t.date, t.amount]);
  assert.deepEqual(unbilled, [
    ["2026-09-29", 17.62],
    ["2026-09-28", 122.83],
    ["2026-09-27", 16.99],
    ["2026-09-27", 98.45],
  ]);
});

const bill = (statement, description, amount, extra = {}) => ({
  date: `${statement}-28`,
  type: extra.type ?? (/^\[\d+\/\d+\]/.test(description) ? "Instalment" : "BNPL"),
  description,
  sign: "-",
  amount,
  statement,
  ...extra,
});
const hist = (date, type, description, amount, extra = {}) => ({ date, type, description, sign: "-", amount, ...extra });

test("reconcile: identical purchases pair one-to-one, in-period first", () => {
  const h1 = hist("2026-08-30", "BNPL", "In Store - SHOP", 10);
  const h2 = hist("2026-09-03", "BNPL", "In Store - SHOP", 10);
  const h3 = hist("2026-09-20", "BNPL", "In Store - SHOP", 10);
  const b1 = bill("2026-09", "In Store - SHOP", 10);
  const b2 = bill("2026-09", "In Store - SHOP", 10);
  const { pairs } = reconcile([h3, b1, h1, b2, h2]);
  assert.equal(pairs.get(b1), h2);
  assert.equal(pairs.get(b2), h3);
});

test("reconcile: purchases after the statement period are never matched", () => {
  const h = hist("2026-10-01", "BNPL", "In Store - SHOP", 10);
  const { pairs } = reconcile([h, bill("2026-09", "In Store - SHOP", 10)]);
  assert.equal(pairs.size, 0);
});

test("reconcile: later instalment parts follow the plan across statements", () => {
  const plan = hist("2026-07-15", "Instalment", "Zenlush『7.7 Sale』Soft Bantal Tidur Pillow", 39.39);
  const p1 = bill("2026-07", "[1/3] Zenlush Soft Bantal Tidur Pillow 亲子枕", 13.13, { part: 1, of: 3 });
  const p2 = bill("2026-08", "[2/3] Zenlush Soft Bantal Tidur Pillow 亲子枕", 13.13, { part: 2, of: 3 });
  const p3 = bill("2026-09", "[3/3] Zenlush Soft Bantal Tidur Pillow 亲子枕", 13.13, { part: 3, of: 3 });
  const { pairs, billedIn } = reconcile([p3, p1, plan, p2]);
  assert.equal(pairs.get(p1), plan);
  assert.equal(pairs.get(p2), plan);
  assert.equal(pairs.get(p3), plan);
  assert.equal(billedIn.get(plan), "2026-07");
});

test("reconcile: an existing ref is honoured", () => {
  const a = hist("2026-09-01", "BNPL", "In Store - SHOP", 10, { id: "a" });
  const b = hist("2026-09-02", "BNPL", "In Store - SHOP", 10, { id: "b" });
  const item = bill("2026-09", "In Store - SHOP", 10, { ref: "b" });
  assert.equal(reconcile([a, b, item]).pairs.get(item), b);
});

test("sameItem tolerates promo tags, [k/n] prefixes and suffixes", () => {
  assert.ok(sameItem("Zenlush『9.25 Big Sale』Soft Bantal Tidur", "[2/3] Zenlush Soft Bantal Tidur 亲子枕"));
  assert.ok(sameItem("In Store - NG CHOY WAN", "In Store - NG CHOY WAN"));
  assert.ok(!sameItem("In Store - NG CHOY WAN", "In Store - NG CHOY"));
  assert.ok(!sameItem("In Store - THONG 1964", "In Store - GREENS FRESH"));
});
