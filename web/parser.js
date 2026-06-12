// ShopeePay paste parser — SPEC.md §4.
// Record shape in the paste (blank lines anywhere are tolerated):
//   <Type: BNPL | Instalment | Bill Payment | Refund>
//   <optional description line(s)>
//   <DD Mon YYYY>
//   <+/- RM9,999.99>
// Runs in the browser and under `node --test` (pure ES module, no DOM).

const TYPES = ["BNPL", "Instalment", "Bill Payment", "Refund"];

const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const DATE_RE = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/;
const AMOUNT_RE = /^([+-])\s*RM\s*([\d,]+\.\d{2})$/i;

function matchType(line) {
  return TYPES.find((t) => t.toLowerCase() === line.toLowerCase()) ?? null;
}

function parseDate(line) {
  const m = line.match(DATE_RE);
  if (!m) return null;
  const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, "0")}`;
}

function parseAmount(line) {
  const m = line.match(AMOUNT_RE);
  if (!m) return null;
  return { sign: m[1], amount: Number(m[2].replace(/,/g, "")) };
}

/**
 * Parse a ShopeePay paste into transactions.
 * Returns { transactions, errors } — errors carry 1-based line numbers.
 */
export function parseShopeePay(text) {
  const lines = text.split(/\r?\n/);
  const transactions = [];
  const errors = [];

  let current = null; // { type, typeLine, description: [] }

  const fail = (lineNo, message) => {
    errors.push({ line: lineNo, message });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const lineNo = i + 1;

    const type = matchType(line);
    if (type) {
      if (current) fail(current.typeLine, `"${current.type}" record never completed (no date/amount)`);
      current = { type, typeLine: lineNo, description: [] };
      continue;
    }

    if (!current) {
      fail(lineNo, `unexpected line outside a record: "${line}"`);
      continue;
    }

    const date = parseDate(line);
    if (date) {
      // Next non-blank line must be the amount.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const amountLine = j < lines.length ? lines[j].trim() : "";
      const parsed = parseAmount(amountLine);
      if (!parsed) {
        fail(lineNo, `expected +/- RM amount after date, got: "${amountLine}"`);
        i = j;
        continue;
      }
      transactions.push({
        date,
        type: current.type,
        description: current.description.join(" ").trim() || current.type,
        sign: parsed.sign,
        amount: parsed.amount,
      });
      current = null;
      i = j;
      continue;
    }

    current.description.push(line);
  }

  if (current) {
    errors.push({
      line: current.typeLine,
      message: `"${current.type}" record never completed (no date/amount)`,
    });
  }

  return { transactions, errors };
}
