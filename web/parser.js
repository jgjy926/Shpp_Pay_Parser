// ShopeePay paste parser — SPEC.md §4.
//
// ShopeePay's copy-paste layout has two shapes in the wild, and this parser
// auto-detects which one it's looking at (see `looksGrouped`):
//
//   A) Per-record ("record mode") — one date + amount under each type:
//        <Type: BNPL | Instalment | Bill Payment | Refund>
//        <optional description line(s)>
//        <DD Mon YYYY>
//        <+/- RM9,999.99>
//
//   B) Grouped statement ("grouped mode") — the newer monthly-statement view.
//      The type appears ONCE as a section header, then many description+amount
//      pairs follow with NO per-item date, and amounts have no +/- sign:
//        <header: Unpaid Amount / Due Date DD Mon YYYY / Total N transactions /
//                 DD Mon - DD Mon  (statement period)>
//        <Type: BNPL>
//        <description>
//        <RM20.00>
//        <description>
//        <RM24.00>
//        ...
//        <Type: Instalment>
//        ...
//      Every item in a statement shares one date (the statement month) because
//      the export no longer carries per-item days. Sign defaults by type
//      (Refund → +, everything else → −). The `date`/`amount` fixed-2dp id in
//      the Worker keeps distinct same-merchant/same-amount items apart, so the
//      genuine duplicates a statement contains are all preserved.
//      Grouped items also carry `statement` (YYYY-MM) and, for instalment parts
//      tagged "[k/n]", `part`/`of` — reconcile.js uses these to match each bill
//      item to its dated purchase in the transaction history.
//
//   Both layouts may be pasted together (bill + transaction history, any
//   order). The dated records form one contiguous span; whatever sits outside
//   it is parsed as its own segment (see `parseShopeePay`).
//
// Runs in the browser and under `node --test` (pure ES module, no DOM).

const TYPES = ["BNPL", "Instalment", "Bill Payment", "Refund"];

const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const DATE_RE = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/;
// Amount line: sign optional (grouped statements drop it), 2 decimals required
// so product names that merely contain "RM" (e.g. "XOX RM10") never match.
const AMOUNT_RE = /^([+-])?\s*RM\s*([\d,]+\.\d{2})$/i;
// Statement-period line, e.g. "01 Aug - 31 Aug" (no year — that comes from the
// due-date line). Only used to locate the statement month in grouped mode.
const PERIOD_RE = /^(\d{1,2})\s+([A-Za-z]{3,9})\s*[-–—]\s*(\d{1,2})\s+([A-Za-z]{3,9})$/;
const DUE_RE = /Due Date\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/i;
const TOTAL_RE = /Total\s+(\d+)\s+transaction/i;

function matchType(line) {
  return TYPES.find((t) => t.toLowerCase() === line.toLowerCase()) ?? null;
}

function monthNum(name) {
  return MONTHS[name.slice(0, 3).toLowerCase()] ?? null;
}

function parseDate(line) {
  const m = line.match(DATE_RE);
  if (!m) return null;
  const month = monthNum(m[2]);
  if (!month) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, "0")}`;
}

function parseAmount(line) {
  const m = line.match(AMOUNT_RE);
  if (!m) return null;
  return { sign: m[1] ?? null, amount: Number(m[2].replace(/,/g, "")) };
}

const defaultSign = (type) => (type === "Refund" ? "+" : "-");

// Last calendar day of a 1-based month as a padded string, e.g. (2026,"08")→"31".
function lastDay(year, month) {
  return String(new Date(Number(year), Number(month), 0).getDate()).padStart(2, "0");
}

/**
 * Grouped statements have no per-item date, so every item inherits the
 * statement month, anchored to its LAST day (the export only tells us the
 * billing month, not the day). Derive the month from the period line
 * ("01 Aug - 31 Aug") and the year from the due-date line, rolling the year
 * back when the period sits in the previous calendar year from its due date
 * (Dec → due Jan). Scans only the header lines above the first type section.
 * With no year anywhere in the header, `yearFor(month)` supplies one.
 * Returns YYYY-MM-DD or null when the month can't be determined.
 */
function deriveStatementDate(headerLines, yearFor) {
  const text = headerLines.join("\n");
  const due = text.match(DUE_RE);
  const dueYear = due ? Number(due[3]) : null;
  const dueMonth = due ? monthNum(due[2]) : null;

  for (const line of headerLines) {
    const p = line.match(PERIOD_RE);
    if (!p) continue;
    const month = monthNum(p[2]);
    if (!month) continue;
    let year = dueYear ?? (text.match(/\b(20\d{2})\b/) || [])[1];
    if (year == null) {
      // "The bill has been paid in full" replaces the Due Date line, leaving
      // the period with no year at all — borrow one from the caller.
      year = yearFor(month);
    } else {
      year = Number(year);
      // Period month later than its due month ⇒ statement is the prior year.
      if (dueMonth && month > dueMonth) year -= 1;
    }
    return `${year}-${month}-${lastDay(year, month)}`;
  }

  // No period line — fall back to "the month before the due date".
  if (dueYear && dueMonth) {
    let y = dueYear;
    let mo = Number(dueMonth) - 1;
    if (mo === 0) { mo = 12; y -= 1; }
    const mm = String(mo).padStart(2, "0");
    return `${y}-${mm}-${lastDay(y, mm)}`;
  }
  return null;
}

// Grouped mode if amount lines clearly outnumber date lines — i.e. items are
// listed without their own dates. Record mode carries one date per amount, so
// amounts ≈ dates there; grouped statements have amounts but ~no per-line dates.
function countLines(lines, start, end) {
  let amounts = 0;
  let dates = 0;
  for (let i = start; i < end; i++) {
    const line = lines[i].trim();
    if (AMOUNT_RE.test(line)) amounts++;
    if (DATE_RE.test(line)) dates++;
  }
  return { amounts, dates };
}

function looksGrouped(lines, start, end) {
  const { amounts, dates } = countLines(lines, start, end);
  return amounts > 0 && amounts > dates * 2;
}

function nextNonBlank(lines, i) {
  while (i < lines.length && !lines[i].trim()) i++;
  return i;
}

/** Line range [start, end) spanning every well-formed dated record, or null. */
function datedSpan(lines) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!DATE_RE.test(lines[i].trim())) continue;
    const j = nextNonBlank(lines, i + 1);
    if (j >= lines.length || !AMOUNT_RE.test(lines[j].trim())) continue;
    if (first === -1) first = i;
    last = j;
  }
  if (first === -1) return null;
  let start = first;
  while (start > 0 && !matchType(lines[start].trim())) start--;
  return { start, end: last + 1 };
}

/**
 * Year for a statement month whose header has none: a dated record from that
 * month in the same paste wins; otherwise the most recent such month that is
 * not in the future relative to `today`.
 */
function yearResolver(lines, today) {
  const seen = new Map(); // "MM" -> year
  for (const raw of lines) {
    const d = parseDate(raw.trim());
    if (d) seen.set(d.slice(5, 7), Number(d.slice(0, 4)));
  }
  return (month) => {
    if (seen.has(month)) return seen.get(month);
    const y = today.getFullYear();
    return Number(month) > today.getMonth() + 1 ? y - 1 : y;
  };
}

/**
 * Parse a ShopeePay paste into transactions.
 * Returns { transactions, errors, ignored } — all carry 1-based line numbers.
 * `ignored` is app chrome around the records (headers like "All Transactions",
 * statement summary, footer buttons) — expected in every real paste, so not an
 * error.
 */
export function parseShopeePay(text, { today = new Date() } = {}) {
  const lines = text.split(/\r?\n/);
  const yearFor = yearResolver(lines, today);
  const span = datedSpan(lines);
  if (!span) {
    return looksGrouped(lines, 0, lines.length)
      ? parseGrouped(lines, 0, lines.length, yearFor)
      : parseRecords(lines, 0, lines.length);
  }

  // Dated records (transaction history) form one contiguous span; a bill
  // pasted before or after it is a separate segment, as is app chrome.
  const parts = [];
  const outer = (start, end) => {
    if (start >= end) return;
    const { amounts, dates } = countLines(lines, start, end);
    if (amounts > 0 && amounts > dates * 2) {
      parts.push(parseGrouped(lines, start, end, yearFor));
    } else if (amounts || dates) {
      parts.push(parseRecords(lines, start, end));
    } else {
      // No amounts or dates: filter tabs ("All / Checkout / Bill Payment /
      // Refund"), month headers, footers — chrome, even where it spells a type.
      const ignored = [];
      for (let i = start; i < end; i++) {
        if (lines[i].trim()) ignored.push({ line: i + 1, text: lines[i].trim() });
      }
      parts.push({ transactions: [], errors: [], ignored });
    }
  };
  outer(0, span.start);
  parts.push(parseRecords(lines, span.start, span.end));
  outer(span.end, lines.length);

  return {
    transactions: parts.flatMap((p) => p.transactions),
    errors: parts.flatMap((p) => p.errors),
    ignored: parts.flatMap((p) => p.ignored),
  };
}

// ---- Grouped statement format (type as section header, no per-item dates) ----

const PART_RE = /^\[(\d+)\/(\d+)\]/;

function parseGrouped(lines, start, end, yearFor) {
  const transactions = [];
  const errors = [];
  const ignored = [];

  // The header sits above the first type section; mine it for the statement
  // date, the declared transaction count and the bill amount.
  let firstType = start;
  while (firstType < end && !matchType(lines[firstType].trim())) firstType++;
  const header = lines.slice(start, firstType);
  const statementDate = deriveStatementDate(header, yearFor);
  const statement = statementDate?.slice(0, 7);
  let expected = null;
  let totalLine = 0;
  let billAmount = null;
  let billLine = 0;
  header.forEach((l, idx) => {
    const m = l.match(TOTAL_RE);
    if (m) {
      expected = Number(m[1]);
      totalLine = start + idx + 1;
    }
    if (/^Bill Amount$/i.test(l.trim())) {
      const j = nextNonBlank(header, idx + 1);
      const amt = j < header.length ? parseAmount(header[j].trim()) : null;
      if (amt) {
        billAmount = amt.amount;
        billLine = start + idx + 1;
      }
    }
  });

  let section = null;
  let desc = [];

  for (let i = start; i < end; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const lineNo = i + 1;

    const type = matchType(line);
    if (type) {
      // Any leftover description with no amount is footer/partial chrome.
      for (const d of desc) ignored.push({ line: d.line, text: d.text });
      desc = [];
      section = type;
      continue;
    }

    if (!section) {
      ignored.push({ line: lineNo, text: line });
      continue;
    }

    const parsed = parseAmount(line);
    if (parsed) {
      if (!statementDate) {
        errors.push({
          line: lineNo,
          message: "could not determine statement month (no period/due date in header)",
        });
        desc = [];
        continue;
      }
      const description = desc.map((d) => d.text).join(" ").trim() || section;
      const part = description.match(PART_RE);
      transactions.push({
        date: statementDate,
        type: section,
        description,
        sign: parsed.sign ?? defaultSign(section),
        amount: parsed.amount,
        statement,
        ...(part ? { part: Number(part[1]), of: Number(part[2]) } : {}),
      });
      desc = [];
      continue;
    }

    desc.push({ line: lineNo, text: line });
  }

  // Trailing description after the last amount is footer chrome, not an error.
  for (const d of desc) ignored.push({ line: d.line, text: d.text });

  if (expected != null && transactions.length !== expected) {
    errors.push({
      line: totalLine,
      message: `statement declares ${expected} transactions but ${transactions.length} were parsed`,
    });
  }

  // Cross-check against the statement's own total (charges less refunds).
  if (billAmount != null && transactions.length) {
    const net = transactions.reduce((a, t) => a + (t.sign === "+" ? -t.amount : t.amount), 0);
    if (Math.abs(net - billAmount) >= 0.005) {
      errors.push({
        line: billLine,
        message: `statement Bill Amount is RM${billAmount.toFixed(2)} but parsed items total RM${net.toFixed(2)}`,
      });
    }
  }

  return { transactions, errors, ignored };
}

// ---- Per-record format (each record carries its own date + amount) ----

function parseRecords(lines, start, end) {
  const transactions = [];
  const errors = [];
  const ignored = [];

  let current = null; // { type, typeLine, description: [] }

  const fail = (lineNo, message) => {
    errors.push({ line: lineNo, message });
    current = null;
  };

  for (let i = start; i < end; i++) {
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
      ignored.push({ line: lineNo, text: line });
      continue;
    }

    const date = parseDate(line);
    if (date) {
      // Next non-blank line must be the amount.
      const j = nextNonBlank(lines, i + 1);
      const amountLine = j < end ? lines[j].trim() : "";
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
        sign: parsed.sign ?? defaultSign(current.type),
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

  return { transactions, errors, ignored };
}
