/**
 * unambiguousDateColumnNames / applyDateColumnFormatting — the
 * column-type-aware fix for E1B_PHASE_E_SCOPING_PLAN.md §5.4 (a typed
 * `date` lake column round-trips through DuckDB as a JS Date, which JSON
 * turns into a full ISO instant that breaks ChartBlock's smartXLabel
 * regex). See dateColumnNames.ts's own module comment for why a blanket
 * "any midnight-UTC Date is a date" rule at the connection layer was
 * rejected in favour of consulting the tenant's actual declared schema.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  tables: [] as Array<{ name: string; schemaJson: string }>,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    lakeTable: {
      findMany: vi.fn(async () => h.tables),
    },
  },
}));

import { unambiguousDateColumnNames, applyDateColumnFormatting, forgetLakeCatalog } from "./dateColumnNames";
import { prisma } from "@/lib/db";

function setTables(tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>) {
  h.tables = tables.map((t) => ({ name: t.name, schemaJson: JSON.stringify(t.columns) }));
  // The catalog is cached per tenant: each case sets its own.
  forgetLakeCatalog("t1");
}

describe("unambiguousDateColumnNames", () => {
  it("names a column date when the SQL references a table declaring it as date", async () => {
    setTables([{ name: "monthly_snap", columns: [{ name: "snap_date", type: "date" }, { name: "mrr", type: "number" }] }]);
    const names = await unambiguousDateColumnNames("t1", `SELECT snap_date, mrr FROM monthly_snap`);
    expect(names).toEqual(new Set(["snap_date"]));
  });

  it("ignores a table the SQL doesn't reference", async () => {
    setTables([
      { name: "monthly_snap", columns: [{ name: "snap_date", type: "date" }] },
      { name: "other_table", columns: [{ name: "created", type: "date" }] },
    ]);
    const names = await unambiguousDateColumnNames("t1", `SELECT snap_date FROM monthly_snap`);
    expect(names).toEqual(new Set(["snap_date"]));
  });

  it("leaves a column name alone when it's date in one referenced table and not in another", async () => {
    // "created" is a date on customers but plain text on tickets ("created" as
    // a freeform status note, say) — a query joining both shouldn't guess.
    setTables([
      { name: "customers", columns: [{ name: "created", type: "date" }] },
      { name: "tickets", columns: [{ name: "created", type: "text" }] },
    ]);
    const names = await unambiguousDateColumnNames("t1", `SELECT created FROM customers JOIN tickets ON 1=1`);
    expect(names).toEqual(new Set());
  });

  it("returns an empty set when the SQL references no known table", async () => {
    setTables([{ name: "monthly_snap", columns: [{ name: "snap_date", type: "date" }] }]);
    const names = await unambiguousDateColumnNames("t1", `SELECT 1`);
    expect(names).toEqual(new Set());
  });

  it("tolerates a malformed schemaJson cache for one table without losing the others", async () => {
    h.tables = [
      { name: "broken", schemaJson: "{not json" },
      { name: "monthly_snap", schemaJson: JSON.stringify([{ name: "snap_date", type: "date" }]) },
    ];
    const names = await unambiguousDateColumnNames("t1", `SELECT snap_date FROM monthly_snap JOIN broken ON 1=1`);
    expect(names).toEqual(new Set(["snap_date"]));
  });
});

describe("applyDateColumnFormatting", () => {
  it("reformats a midnight-UTC Date under a vetted name to YYYY-MM-DD", () => {
    const rows = [{ snap_date: new Date("2026-03-01T00:00:00.000Z"), mrr: 111000 }];
    applyDateColumnFormatting(rows, new Set(["snap_date"]));
    expect(rows[0]).toEqual({ snap_date: "2026-03-01", mrr: 111000 });
  });

  it("leaves a non-midnight Date under a vetted name untouched — a real timestamp, not a bare date", () => {
    const rows = [{ event_at: new Date("2026-03-01T10:30:00.000Z") }];
    applyDateColumnFormatting(rows, new Set(["event_at"]));
    expect(rows[0].event_at).toBeInstanceOf(Date);
  });

  it("leaves a non-Date value under a vetted name untouched (already NULL, or a text fallback)", () => {
    const rows = [{ snap_date: null }, { snap_date: "already-a-string" }];
    applyDateColumnFormatting(rows, new Set(["snap_date"]));
    expect(rows[0].snap_date).toBeNull();
    expect(rows[1].snap_date).toBe("already-a-string");
  });

  it("no-ops entirely when the vetted set is empty (fast path)", () => {
    const rows = [{ x: new Date("2026-01-01T00:00:00.000Z") }];
    applyDateColumnFormatting(rows, new Set());
    expect(rows[0].x).toBeInstanceOf(Date);
  });

  it("does not touch a column not in the vetted set even if it's a midnight Date", () => {
    const rows = [{ other: new Date("2026-01-01T00:00:00.000Z") }];
    applyDateColumnFormatting(rows, new Set(["snap_date"]));
    expect(rows[0].other).toBeInstanceOf(Date);
  });
});

describe("the catalog behind it (audit 2026-09-30, P5)", () => {
  it("is read once per tenant rather than on every query, and read again once the lake changes", async () => {
    setTables([{ name: "monthly_snap", columns: [{ name: "snap_date", type: "date" }] }]);
    vi.mocked(prisma.lakeTable.findMany).mockClear();
    await unambiguousDateColumnNames("t1", "SELECT snap_date FROM monthly_snap");
    await unambiguousDateColumnNames("t1", "SELECT snap_date FROM monthly_snap");
    expect(prisma.lakeTable.findMany).toHaveBeenCalledTimes(1);

    // The column was retyped: bustLakeCacheForTenant forgets the catalog, and the next query sees it.
    h.tables = [{ name: "monthly_snap", schemaJson: JSON.stringify([{ name: "snap_date", type: "text" }]) }];
    forgetLakeCatalog("t1");
    expect(await unambiguousDateColumnNames("t1", "SELECT snap_date FROM monthly_snap")).toEqual(new Set());
    expect(prisma.lakeTable.findMany).toHaveBeenCalledTimes(2);
  });
});
