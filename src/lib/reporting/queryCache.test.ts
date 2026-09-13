import { describe, it, expect } from "vitest";
import { getCachedRows, setCachedRows } from "@/lib/reporting/queryCache";
import { buildProvenance, hashRows } from "@/lib/reporting/provenance";
import type { DataSourceDef } from "@/lib/reporting/schema";

const ds = { id: "q1", name: "Test query", sql: "select * from t" } as DataSourceDef;

describe("queryCache dataHash", () => {
  it("returns the dataHash stored at write time on a subsequent hit", () => {
    const opts = { tenantId: "t1", dataSourceId: "ds1", sql: "select 1", params: {} };
    const rows = [{ a: 1 }, { a: 2 }];
    const dataHash = hashRows(rows);
    setCachedRows({ ...opts, rows, dataHash });

    const hit = getCachedRows(opts);
    expect(hit).not.toBeNull();
    expect(hit!.dataHash).toBe(dataHash);
    expect(hit!.rows).toEqual(rows);
  });

  it("misses cleanly when the key differs", () => {
    const miss = getCachedRows({
      tenantId: "t1",
      dataSourceId: "ds1",
      sql: "select 2 -- never cached",
      params: {},
    });
    expect(miss).toBeNull();
  });
});

describe("buildProvenance dataHash reuse", () => {
  it("uses a supplied dataHash instead of recomputing hashRows", () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const precomputed = "sha256:not-the-real-hash";
    const record = buildProvenance({
      ds,
      rows,
      params: {},
      dataSourceName: "Curf Tables",
      dataSourceKind: "sqlite",
      startedAt: Date.now(),
      dataHash: precomputed,
    });
    // Proves the cached value was passed through untouched, not recomputed
    // from `rows` (which would never equal this sentinel string).
    expect(record.dataHash).toBe(precomputed);
  });

  it("falls back to hashRows(rows) when no dataHash is supplied", () => {
    const rows = [{ a: 1 }, { a: 2 }];
    const record = buildProvenance({
      ds,
      rows,
      params: {},
      dataSourceName: "Curf Tables",
      dataSourceKind: "sqlite",
      startedAt: Date.now(),
    });
    expect(record.dataHash).toBe(hashRows(rows));
  });
});
