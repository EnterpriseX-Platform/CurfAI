import { describe, expect, it } from "vitest";
import { dataAsOf, inferGrain, parseBucket, partialLastPeriod, weekRange } from "./partialPeriod";
import { weekStartLabel } from "./periodLabel";

const day = (s: string) => new Date(`${s}T12:00:00`); // a local wall-clock moment on that date
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("weekRange", () => {
  it("reads %Y-W%W the way SQLite/DuckDB strftime writes it (Monday-first, week 01 = first Monday)", () => {
    // 2026-01-01 is a Thursday: the first Monday is 5 Jan.
    expect(iso(weekRange(2026, 1)!.start)).toBe("2026-01-05");
    expect(iso(weekRange(2026, 29)!.start)).toBe("2026-07-20");
    expect(iso(weekRange(2026, 39)!.start)).toBe("2026-09-28");
    expect(iso(weekRange(2026, 0)!.start)).toBe("2026-01-01");
    expect(iso(weekRange(2026, 0)!.end)).toBe("2026-01-05");
    // The last week of the year stops at 31 December.
    expect(iso(weekRange(2026, 52)!.end)).toBe("2027-01-01");
  });
  it("reads ISO 8601 weeks when asked", () => {
    expect(iso(weekRange(2026, 1, "iso")!.start)).toBe("2025-12-29");
    expect(iso(weekRange(2026, 39, "iso")!.start)).toBe("2026-09-21");
  });
});

describe("parseBucket / inferGrain", () => {
  it("knows self-describing buckets", () => {
    expect(parseBucket("2026-W39")?.grain).toBe("week");
    expect(parseBucket("2026-Q3")).toMatchObject({ grain: "quarter" });
    expect(iso(parseBucket("2026-Q3")!.end)).toBe("2026-10-01");
    expect(iso(parseBucket("2026-02")!.end)).toBe("2026-03-01");
    expect(parseBucket("2026")?.grain).toBe("year");
    expect(parseBucket("North")).toBeNull();
    expect(parseBucket("2026-09-24")).toBeNull(); // a bare date needs a grain
  });
  it("infers an ISO-date axis's grain from its gaps", () => {
    expect(inferGrain(["2026-09-21", "2026-09-22", "2026-09-23"])).toBe("day");
    expect(inferGrain(["2026-09-07", "2026-09-14", "2026-09-21"])).toBe("week");
    expect(inferGrain(["2026-07-01", "2026-08-01", "2026-09-01"])).toBe("month");
    expect(inferGrain(["2026-W37", "2026-W38"])).toBe("week");
    expect(inferGrain(["North", "South"])).toBeNull();
    expect(inferGrain(["2026-W37", "2026-09"])).toBeNull();
  });
});

describe("partialLastPeriod", () => {
  const now = day("2026-10-01"); // Thursday of %W week 39 (28 Sep – 4 Oct)
  it("marks the current week of week strings", () => {
    const p = partialLastPeriod(["2026-W37", "2026-W38", "2026-W39"], { now });
    expect(p).toMatchObject({ index: 2, grain: "week" });
  });
  it("leaves a finished last week alone", () => {
    expect(partialLastPeriod(["2026-W36", "2026-W37", "2026-W38"], { now })).toBeNull();
  });
  it("marks the current month (YYYY-MM and first-of-month dates)", () => {
    expect(partialLastPeriod(["2026-08", "2026-09", "2026-10"], { now })?.index).toBe(2);
    expect(partialLastPeriod(["2026-08-01", "2026-09-01", "2026-10-01"], { now })?.grain).toBe("month");
    expect(partialLastPeriod(["2026-07", "2026-08", "2026-09"], { now })).toBeNull();
  });
  it("marks today on a daily ISO-date axis and the running quarter", () => {
    expect(partialLastPeriod(["2026-09-29", "2026-09-30", "2026-10-01"], { now })?.grain).toBe("day");
    expect(partialLastPeriod(["2026-09-28", "2026-09-29", "2026-09-30"], { now })).toBeNull();
    expect(partialLastPeriod(["2026-Q3", "2026-Q4"], { now })?.grain).toBe("quarter");
  });
  it("marks a weekly ISO-date axis whose last week is running", () => {
    expect(partialLastPeriod(["2026-09-14", "2026-09-21", "2026-09-28"], { now })?.index).toBe(2);
  });
  it("uses the data's own as-of date when it stops before the bucket's last day", () => {
    const later = day("2027-03-01");
    expect(partialLastPeriod(["2026-08", "2026-09"], { now: later })).toBeNull();
    expect(partialLastPeriod(["2026-08", "2026-09"], { now: later, asOf: new Date("2026-09-17") })?.index).toBe(1);
    expect(partialLastPeriod(["2026-08", "2026-09"], { now: later, asOf: new Date("2026-09-30") })).toBeNull();
  });
  it("ignores an axis that isn't in time order or isn't time", () => {
    expect(partialLastPeriod(["2026-W39", "2026-W37", "2026-W38"], { now })).toBeNull();
    expect(partialLastPeriod(["North", "South"], { now })).toBeNull();
    expect(partialLastPeriod([], { now })).toBeNull();
  });
});

describe("dataAsOf", () => {
  it("reads an as-of column of the last row, never a bucket-start column", () => {
    expect(iso(dataAsOf([{ week: "2026-W39", as_of: "2026-09-30" }], "week")!)).toBe("2026-09-30");
    expect(iso(dataAsOf([{ m: "2026-09", last_day: "2026-09-17T00:00:00Z" }], "m")!)).toBe("2026-09-17");
    expect(dataAsOf([{ week: "2026-W39", week_start: "2026-09-28" }], "week")).toBeNull();
    expect(dataAsOf([], "week")).toBeNull();
  });
});

describe("weekStartLabel", () => {
  it("reads a week as its first day in the reader's language", () => {
    expect(weekStartLabel("2026-W29", { locale: "en" })).toBe("20 Jul");
    expect(weekStartLabel("2026-W29", { locale: "en" }, "full")).toBe("20 Jul 2026");
    expect(weekStartLabel("2026-W29", { locale: "th", era: "be" })).toBe("20 ก.ค.");
    expect(weekStartLabel("2026-W29", { locale: "th", era: "be" }, "full")).toBe("20 ก.ค. 2569");
    expect(weekStartLabel("2026-W29", { locale: "th", era: "ce" }, "full")).toBe("20 ก.ค. 2026");
    expect(weekStartLabel("2026-W29", { locale: "zh" })).toBe("7月20日");
    expect(weekStartLabel("2026-W29", { locale: "zh" }, "full")).toBe("2026年7月20日");
  });
  it("leaves everything else to the other formatters", () => {
    expect(weekStartLabel("2026-09", { locale: "en" })).toBeNull();
    expect(weekStartLabel("North", { locale: "en" })).toBeNull();
    expect(weekStartLabel(2026, { locale: "en" })).toBeNull();
  });
});
