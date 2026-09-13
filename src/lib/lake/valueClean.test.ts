/**
 * valueClean — cell-level type detection and cleaning.
 *
 * The cases here are drawn directly from the audit that motivated this
 * file: ten realistic messy-CSV inputs, eight of which the old
 * first-mismatch-wins inferColumns() mistyped as text. Each of those eight
 * gets its own test below, named after the failure it fixes.
 */
import { describe, it, expect } from "vitest";
import {
  isNullToken, cleanNumericToken, cleanDateToken, detectCellType, cleanForType,
  detectDateOrder,
} from "./valueClean";

describe("isNullToken", () => {
  it.each(["", "N/A", "n/a", "NA", "-", "--", "NULL", "null", "None", "TBD", "#N/A", "?"])(
    "%s is null",
    (tok) => expect(isNullToken(tok)).toBe(true),
  );

  it.each(["0", "N", "A", "NAT", "-1", "Not applicable"])(
    "%s is NOT null — must not over-match real values",
    (tok) => expect(isNullToken(tok)).toBe(false),
  );
});

describe("cleanNumericToken — the audit's failing cases", () => {
  it("one 'N/A' among numbers no longer poisons the column", () => {
    // isNullToken() is what makes this safe — inferColumns excludes null
    // tokens from the vote entirely, so this case is really isNullToken's
    // job; cleanNumericToken itself just needs to keep working on the
    // genuine numbers around it.
    expect(cleanNumericToken("100")).toBe("100");
    expect(cleanNumericToken("375")).toBe("375");
  });

  it("currency symbols: $1,299.00", () => {
    expect(cleanNumericToken("$1,299.00")).toBe("1299");
  });

  it("Thai Baht — Curf's primary market currency", () => {
    expect(cleanNumericToken("฿899.50")).toBe("899.5");
  });

  it("thousands separators with no currency symbol: 1,234", () => {
    expect(cleanNumericToken("1,234")).toBe("1234");
  });

  it("percent sign, stored as a bare point value not divided by 100", () => {
    // Matches percentStoredAsPoints()'s own detection convention — see the
    // module docstring for why dividing here would be the wrong call.
    expect(cleanNumericToken("45%")).toBe("45");
  });

  it("Excel's #N/A is a null token, not a number", () => {
    expect(isNullToken("#N/A")).toBe(true);
  });

  it("accounting negative parens", () => {
    expect(cleanNumericToken("(1,234.56)")).toBe("-1234.56");
  });

  it("leading plus sign", () => {
    expect(cleanNumericToken("+42")).toBe("42");
  });

  it.each(["abc", "", "12.34.56", "N/A", "-"])(
    "%s is not a number",
    (v) => expect(cleanNumericToken(v)).toBeNull(),
  );

  it("rejects a comma pattern that isn't real thousands-grouping", () => {
    // "1,2,3" reads like a malformed list (e.g. comma-separated tag ids),
    // not a formatted number — stripping commas blindly would silently
    // fabricate "123" out of it. Only proper 3-digit grouping strips.
    expect(cleanNumericToken("1,2,3")).toBeNull();
    expect(cleanNumericToken("1,23")).toBeNull();
    expect(cleanNumericToken("12,3456")).toBeNull();
  });

  it("accepts multi-group thousands separators", () => {
    expect(cleanNumericToken("12,345,678")).toBe("12345678");
    expect(cleanNumericToken("1,234.56")).toBe("1234.56");
  });

  it("negative zero normalizes to a plain zero", () => {
    expect(cleanNumericToken("-0")).toBe("0");
  });

  it("refuses to classify a leading-zero integer as a number — protects ZIP/ID columns", () => {
    // "00501" round-tripped through Number() would become "501", silently
    // destroying a ZIP code or member id on write. Left as text instead.
    expect(cleanNumericToken("00501")).toBeNull();
    expect(cleanNumericToken("007")).toBeNull();
  });

  it("still accepts a genuine decimal starting with 0", () => {
    expect(cleanNumericToken("0.5")).toBe("0.5");
    expect(cleanNumericToken("0")).toBe("0");
  });
});

describe("cleanDateToken — the audit's failing cases", () => {
  it("already-ISO passes through", () => {
    expect(cleanDateToken("2024-01-15")).toBe("2024-01-15");
    expect(cleanDateToken("2024-01-15T10:30:00Z")).toBe("2024-01-15");
  });

  it("US slash format: 01/15/2024", () => {
    expect(cleanDateToken("01/15/2024")).toBe("2024-01-15");
  });

  it("single-digit month/day: 1/5/2024", () => {
    expect(cleanDateToken("1/5/2024")).toBe("2024-01-05");
  });

  it("dash-separated US format: 01-15-2024", () => {
    expect(cleanDateToken("01-15-2024")).toBe("2024-01-15");
  });

  it("written month, month-first: Jan 15, 2024", () => {
    expect(cleanDateToken("Jan 15, 2024")).toBe("2024-01-15");
  });

  it("written month, no comma: January 15 2024", () => {
    expect(cleanDateToken("January 15 2024")).toBe("2024-01-15");
  });

  it("written month, day-first: 15 Jan 2024", () => {
    expect(cleanDateToken("15 Jan 2024")).toBe("2024-01-15");
  });

  it("refuses to guess an ambiguous slash date rather than answer wrong", () => {
    // 15 can't be a month, so this one IS unambiguous and should resolve —
    // guards the parser actually rejects true 13+ "months" elsewhere.
    expect(cleanDateToken("13/40/2024")).toBeNull();
  });

  it.each(["not a date", "", "2024", "99/99/9999"])(
    "%s is not a date",
    (v) => expect(cleanDateToken(v)).toBeNull(),
  );

  it("rejects a nonexistent calendar date (Feb 30)", () => {
    expect(cleanDateToken("2024-02-30")).toBeNull();
    expect(cleanDateToken("02/30/2024")).toBeNull();
  });
});

describe("detectCellType", () => {
  it("prefers number over date for a bare year-like value", () => {
    expect(detectCellType("2024")).toBe("number");
  });

  it("recognizes literal true/false only, not yes/no/1/0", () => {
    expect(detectCellType("true")).toBe("boolean");
    expect(detectCellType("FALSE")).toBe("boolean");
    // These stay a different type on purpose — see the module docstring on
    // why "yes"/"no" auto-detection would false-positive too often.
    expect(detectCellType("yes")).toBe("text");
    expect(detectCellType("1")).toBe("number");
  });

  it("classifies each of the audit's originally-broken inputs correctly", () => {
    expect(detectCellType("$1,299.00")).toBe("number");
    expect(detectCellType("1,234")).toBe("number");
    expect(detectCellType("45%")).toBe("number");
    expect(detectCellType("01/15/2024")).toBe("date");
    expect(detectCellType("Jan 15, 2024")).toBe("date");
  });
});

describe("cleanForType — the write-time contract", () => {
  it("cleans a number cell for a number column", () => {
    expect(cleanForType("$1,299.00", "number")).toBe("1299");
  });

  it("cleans a date cell for a date column", () => {
    expect(cleanForType("01/15/2024", "date")).toBe("2024-01-15");
  });

  it("normalizes boolean casing", () => {
    expect(cleanForType("TRUE", "boolean")).toBe("true");
  });

  it("leaves an unparseable cell as its ORIGINAL raw text — never nulls real data", () => {
    // The whole point: a stray "Pending" in a number column is a real value
    // someone typed. Silently discarding it would be worse than leaving it
    // as text CAST(...) will treat as 0.
    expect(cleanForType("Pending", "number")).toBe("Pending");
    expect(cleanForType("not a date", "date")).toBe("not a date");
  });

  it("is a no-op for text and unknown columns", () => {
    expect(cleanForType("$1,299.00", "text")).toBe("$1,299.00");
    expect(cleanForType("anything", "unknown")).toBe("anything");
  });
});

/**
 * Day-first vs month-first. "03/04/2024" is a valid date both ways, so no
 * single cell settles it — but a column almost always does, and getting it
 * wrong moves a date by up to eleven months with nothing to show for it.
 */
describe("detectDateOrder — decided per column, not per cell", () => {
  it("reads a day above 12 as proof of day-first", () => {
    expect(detectDateOrder(["03/04/2024", "13/04/2024", "01/02/2024"]))
      .toEqual({ order: "dmy", ambiguous: false });
  });

  it("reads a second component above 12 as proof of month-first", () => {
    expect(detectDateOrder(["03/04/2024", "04/25/2024"]))
      .toEqual({ order: "mdy", ambiguous: false });
  });

  it("flags a column that offers no proof either way", () => {
    // Every value works both ways. Real, just undecidable from the data.
    expect(detectDateOrder(["03/04/2024", "01/02/2024"]))
      .toEqual({ order: "mdy", ambiguous: true });
  });

  it("flags a column that contains proof of BOTH — it disagrees with itself", () => {
    expect(detectDateOrder(["13/04/2024", "04/25/2024"]))
      .toEqual({ order: "mdy", ambiguous: true });
  });

  it("ignores values that aren't slash dates at all", () => {
    expect(detectDateOrder(["2024-01-15", "N/A", "", "hello", "25/12/2024"]))
      .toEqual({ order: "dmy", ambiguous: false });
  });

  it("returns the fallback for a column with no dates in it", () => {
    expect(detectDateOrder([])).toEqual({ order: "mdy", ambiguous: true });
  });
});

describe("cleanDateToken — order is the caller's to supply", () => {
  it("reads the same string both ways, as asked", () => {
    expect(cleanDateToken("03/04/2024", "mdy")).toBe("2024-03-04");
    expect(cleanDateToken("03/04/2024", "dmy")).toBe("2024-04-03");
  });

  it("parses a day-first date that month-first had to reject", () => {
    // The old parser returned null here (month 13), which cost the column
    // its type vote and landed the whole thing as text.
    expect(cleanDateToken("13/04/2024", "dmy")).toBe("2024-04-13");
    expect(cleanDateToken("13/04/2024", "mdy")).toBeNull();
  });

  it("still rejects a date that is impossible under the stated order", () => {
    expect(cleanDateToken("25/13/2024", "dmy")).toBeNull();
    expect(cleanDateToken("02/30/2024", "mdy")).toBeNull();
  });

  it("leaves ISO alone regardless of order", () => {
    expect(cleanDateToken("2024-01-15", "dmy")).toBe("2024-01-15");
  });
});

describe("detectCellType — a date is a date under either reading", () => {
  it("counts a day-first date as a date, not text", () => {
    // This is the vote-level fix: 19 of 31 possible days exceed 12, so
    // under the old month-first-only test most day-first columns lost
    // their vote to text and stopped being dates entirely.
    expect(detectCellType("13/04/2024")).toBe("date");
    expect(detectCellType("25/12/2024")).toBe("date");
  });

  it("still refuses something that is no date under either reading", () => {
    expect(detectCellType("25/13/2024")).toBe("text");
  });
});

describe("cleanForType — applies the column's decided order", () => {
  it("swaps day and month when told the column is day-first", () => {
    expect(cleanForType("03/04/2024", "date", { dateOrder: "dmy" })).toBe("2024-04-03");
    expect(cleanForType("03/04/2024", "date", { dateOrder: "mdy" })).toBe("2024-03-04");
  });

  it("defaults to month-first when no order is supplied", () => {
    expect(cleanForType("03/04/2024", "date")).toBe("2024-03-04");
  });
});
