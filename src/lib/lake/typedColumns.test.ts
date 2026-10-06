/**
 * E1b Phase B (E1B_TYPED_COLUMNS_SCOPING_PLAN.md) — regression coverage
 * for createOrReplaceTable's typed-DDL path, gated behind
 * CURF_LAKE_TYPED_COLUMNS=true (off by default; see typedColumnsEnabled's
 * own doc comment for exactly what's and isn't covered by this flag).
 *
 * Matches this session's "verify against a live request" standard for
 * this specific area: real messy input (currency-formatted numbers,
 * boolean-looking strings, slash dates, a value that won't parse) run
 * through a real in-memory SQLite database, with the flag-off path
 * checked side-by-side against the exact same input to prove the two
 * modes agree on the underlying data even though their physical
 * representation differs.
 *
 * openLake is mocked to a real in-memory better-sqlite3 handle (same
 * pattern as tables.test.ts) so this exercises real SQL and real type
 * affinity, not a stubbed return.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

let db: InstanceType<typeof Database>;

vi.mock("./storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage")>();
  return { ...actual, openLake: () => db };
});

vi.mock("@/ee", () => ({ ee: {} }));

import { createOrReplaceTable, appendRows, storageTypeFor } from "./tables";

function freshDb() {
  db = new Database(":memory:");
  // The real openLake() bootstraps this lazily on first open
  // (storage.ts's bootstrapMeta) — replicated here since the mock above
  // hands back a bare in-memory handle instead of going through it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS __lake_meta (
      table_name TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_config_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      row_count INTEGER NOT NULL DEFAULT 0
    )
  `);
}

const MESSY_ROWS = [
  { amount: "$1,299.00", active: "true", signed_up: "01/15/2026", plan: "enterprise" },
  { amount: "$49.50", active: "false", signed_up: "03/02/2026", plan: "starter" },
  // inferColumns needs a 90% majority to label a column "number"/etc.
  // (tables.ts's TYPE_VOTE_THRESHOLD) — pad the sample with enough clean
  // rows that "amount"/"active"/"signed_up" still clear that bar despite
  // the one deliberately-bad "amount" value below, instead of the whole
  // column silently falling back to "text" and never exercising the
  // typed path this test exists to check.
  { amount: "$10.00", active: "true", signed_up: "04/10/2026", plan: "team" },
  { amount: "$20.00", active: "false", signed_up: "05/11/2026", plan: "team" },
  { amount: "$30.00", active: "true", signed_up: "05/12/2026", plan: "team" },
  { amount: "$40.00", active: "false", signed_up: "05/13/2026", plan: "team" },
  { amount: "$50.00", active: "true", signed_up: "05/14/2026", plan: "team" },
  { amount: "$60.00", active: "false", signed_up: "05/15/2026", plan: "team" },
  { amount: "$70.00", active: "true", signed_up: "05/16/2026", plan: "team" },
  { amount: "$80.00", active: "false", signed_up: "05/17/2026", plan: "team" },
  { amount: "not a number", active: "true", signed_up: "06/20/2026", plan: "business" },
];
/** The same rows without the one "amount" that won't parse: every value converts, so the columns store typed. */
const CLEAN_ROWS = MESSY_ROWS.filter((r) => r.plan !== "business");

const ORIGINAL_FLAG = process.env.CURF_LAKE_TYPED_COLUMNS;
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.CURF_LAKE_TYPED_COLUMNS;
  else process.env.CURF_LAKE_TYPED_COLUMNS = ORIGINAL_FLAG;
});

describe("createOrReplaceTable — CURF_LAKE_TYPED_COLUMNS off (default)", () => {
  it("keeps every column TEXT and every value a string — no behavior change from before Phase B", async () => {
    delete process.env.CURF_LAKE_TYPED_COLUMNS;
    freshDb();
    await createOrReplaceTable({ tenantId: "t1", tableName: "subs", rows: MESSY_ROWS, sourceKind: "upload" });

    const ddl = (db.prepare(`PRAGMA table_info("subs")`).all() as Array<{ name: string; type: string }>);
    for (const col of ddl) expect(col.type).toBe("TEXT");

    const row = db.prepare(`SELECT amount, active FROM subs WHERE plan = 'enterprise'`).get() as any;
    expect(typeof row.amount).toBe("string");
    expect(typeof row.active).toBe("string");
  });
});

describe("createOrReplaceTable — CURF_LAKE_TYPED_COLUMNS on", () => {
  beforeEach(() => {
    process.env.CURF_LAKE_TYPED_COLUMNS = "true";
    freshDb();
  });

  it("emits typed DDL matching sqlTypeForLakeColumn's mapping", async () => {
    await createOrReplaceTable({ tenantId: "t1", tableName: "subs", rows: CLEAN_ROWS, sourceKind: "upload" });
    const ddl = Object.fromEntries(
      (db.prepare(`PRAGMA table_info("subs")`).all() as Array<{ name: string; type: string }>).map((c) => [c.name, c.type]),
    );
    expect(ddl.amount).toBe("REAL");
    expect(ddl.active).toBe("INTEGER");
    expect(ddl.signed_up).toBe("TEXT"); // date — TEXT is the correct SQLite mapping, not a fallback
    expect(ddl.plan).toBe("TEXT");
  });

  it("returns native JS types on read, not strings", async () => {
    await createOrReplaceTable({ tenantId: "t1", tableName: "subs", rows: CLEAN_ROWS, sourceKind: "upload" });
    const row = db.prepare(`SELECT amount, active FROM subs WHERE plan = 'enterprise'`).get() as any;
    expect(row.amount).toBe(1299);
    expect(typeof row.amount).toBe("number");
    expect(row.active).toBe(1); // SQLite has no native boolean; INTEGER 0/1 per sqlTypeForLakeColumn
  });

  it("keeps a column TEXT, every cell as sent, when one of its values won't parse — never nulls it unasked", async () => {
    await createOrReplaceTable({ tenantId: "t1", tableName: "subs", rows: MESSY_ROWS, sourceKind: "upload" });
    const ddl = Object.fromEntries(
      (db.prepare(`PRAGMA table_info("subs")`).all() as Array<{ name: string; type: string }>).map((c) => [c.name, c.type]),
    );
    expect(ddl.amount).toBe("TEXT");
    expect(ddl.active).toBe("INTEGER"); // the other columns still store typed
    const row = db.prepare(`SELECT amount FROM subs WHERE plan = 'business'`).get() as { amount: unknown };
    expect(row.amount).toBe("not a number");
  });

  it("an append into a typed column keeps a value that won't convert, as sent", async () => {
    await createOrReplaceTable({ tenantId: "t1", tableName: "subs", rows: CLEAN_ROWS, sourceKind: "upload" });
    await appendRows({ tenantId: "t1", tableName: "subs", rows: [{ amount: "see note", active: "yes", signed_up: "07/01/2026", plan: "late" }] });
    const row = db.prepare(`SELECT amount, active FROM subs WHERE plan = 'late'`).get() as { amount: unknown; active: unknown };
    expect(row.amount).toBe("see note");
    expect(row.active).toBe("yes"); // not a silent false
  });

  it("agrees with the flag-off path on every value — same semantic content, different physical shape", async () => {
    process.env.CURF_LAKE_TYPED_COLUMNS = "true";
    await createOrReplaceTable({ tenantId: "t1", tableName: "subs_typed", rows: CLEAN_ROWS, sourceKind: "upload" });
    const typedRows = db.prepare(`SELECT plan, amount, active FROM subs_typed ORDER BY plan`).all() as any[];

    process.env.CURF_LAKE_TYPED_COLUMNS = "false";
    await createOrReplaceTable({ tenantId: "t1", tableName: "subs_legacy", rows: CLEAN_ROWS, sourceKind: "upload" });
    const legacyRows = db.prepare(`SELECT plan, amount, active FROM subs_legacy ORDER BY plan`).all() as any[];

    expect(typedRows).toHaveLength(legacyRows.length);
    for (let i = 0; i < typedRows.length; i++) {
      expect(typedRows[i].plan).toBe(legacyRows[i].plan);
      // legacy amount is a cleaned numeric string (or the original raw
      // text when uncleanable) — coercing it to a number must match the
      // typed path's native number (or both must be "doesn't parse").
      expect(typedRows[i].amount).toBe(Number(legacyRows[i].amount));
      expect(typedRows[i].active).toBe(legacyRows[i].active === "true" ? 1 : 0);
    }
  });

  it("still creates the empty-table placeholder the same way regardless of the flag", async () => {
    await createOrReplaceTable({ tenantId: "t1", tableName: "empty", rows: [], sourceKind: "upload" });
    const ddl = db.prepare(`PRAGMA table_info("empty")`).all() as Array<{ name: string; type: string }>;
    expect(ddl).toEqual([{ cid: 0, name: "_empty", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 }]);
  });
});

describe("storageTypeFor", () => {
  it("stores a column typed only when every value converts without loss", () => {
    expect(storageTypeFor({ name: "n", type: "number" }, [{ n: "12" }, { n: 3.5 }, { n: null }, { n: "" }])).toBe("number");
    expect(storageTypeFor({ name: "n", type: "number" }, [{ n: "12" }, { n: "TBD" }])).toBe("text");
    expect(storageTypeFor({ name: "b", type: "boolean" }, [{ b: "true" }, { b: "0" }])).toBe("boolean");
    expect(storageTypeFor({ name: "b", type: "boolean" }, [{ b: "true" }, { b: "yes" }])).toBe("text");
    expect(storageTypeFor({ name: "d", type: "date" }, [{ d: "2026-01-15" }, { d: "2026-01-15T10:00:00Z" }])).toBe("date");
    expect(storageTypeFor({ name: "d", type: "date" }, [{ d: "2026-01-15" }, { d: "soon" }])).toBe("text");
    expect(storageTypeFor({ name: "t", type: "text" }, [{ t: 1 }])).toBe("text");
  });
});
