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
