import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShopeePay } from "../web/parser.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

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
