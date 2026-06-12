import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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

test("garbage between records is reported, parsing continues", () => {
  const { transactions, errors } = parseShopeePay(
    "random header text\nBNPL\nShop A\n03 May 2026\n-RM5.00\n",
  );
  assert.equal(transactions.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
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

// Real export — drop the May 2026 paste into tests/fixtures/may-2026.txt
// to activate (Phase 3 acceptance: 100% of records parse with zero errors).
test("may-2026 real fixture parses 100%", { skip: !existsSync(join(fixturesDir, "may-2026.txt")) }, () => {
  const text = readFileSync(join(fixturesDir, "may-2026.txt"), "utf8");
  const { transactions, errors } = parseShopeePay(text);
  assert.deepEqual(errors, []);
  assert.ok(transactions.length >= 60, `expected 60+ records, got ${transactions.length}`);
});
