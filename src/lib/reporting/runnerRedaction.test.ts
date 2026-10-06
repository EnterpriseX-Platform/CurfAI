/**
 * Regression coverage for column-level redaction inside the report runner.
 * Before this fix, a PII-tagged lake column rendered unmasked in any report
 * a viewer could open — applyRedaction() only ran on the Tables browser and
 * the free-form SQL surfaces (Notebook, Data Quality, Agent, Activations),
 * never in runReportWithProof(), which every chart/table/KPI block reads
 * through. This exercises the real runner against a real (temp file)
 * SQLite lake table — not a mock of the redaction logic itself — so the
 * test fails if the wiring in runner.ts regresses, not just if
 * applyRedaction()'s own rules change.
 *
 * Also covers the subtlest way this fix could go wrong: the query result
 * cache is intentionally NOT keyed by viewer (queryCache.ts), so redacting
 * the cached array in place would leak one viewer's redaction into every
 * other viewer's read of the same cache entry. The "never corrupts the
 * shared query cache" block proves an admin's cached raw read stays raw
 * after a non-admin reads the identical cache entry.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LAKE_DB_PATH = path.join(os.tmpdir(), `curf-redaction-test-${Date.now()}.db`);

beforeAll(() => {
  const db = new Database(LAKE_DB_PATH);
  db.exec(`CREATE TABLE customers (id TEXT, email TEXT)`);
  const insert = db.prepare(`INSERT INTO customers (id, email) VALUES (?, ?)`);
  insert.run("1", "alice@example.com");
  insert.run("2", "bob@example.com");
  db.close();
});
afterAll(() => { try { fs.unlinkSync(LAKE_DB_PATH); } catch { /* best-effort */ } });

vi.mock("@/lib/lake/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lake/storage")>();
  return { ...actual, tenantLakePath: () => LAKE_DB_PATH };
});

const DS_ROW = {
  id: "ds1", tenantId: "t1", kind: "lake", connection: "lake://t1",
  name: "Customers", ownerUserId: null as string | null, visibleToRolesJson: "[]",
};
// Mutated per-test to exercise different sensitivity/allowlist shapes.
let lakeTableSchema: any[] = [];

vi.mock("@/lib/db", () => ({
  prisma: {
    dataSource: { findFirst: vi.fn(async ({ where }: any) => (where.id === "ds1" && where.tenantId === DS_ROW.tenantId ? DS_ROW : null)) },
    lakeTable: {
      findMany: vi.fn(async () => [
        { name: "customers", ownerUserId: null, visibleToRolesJson: "[]", schemaJson: JSON.stringify(lakeTableSchema) },
      ]),
    },
    membership: { findUnique: vi.fn(async () => null) },
  },
}));

import { runReportWithProof, SYSTEM_RUN } from "./runner";
import { ReportSchema } from "./schema";
import { bustForDataSource } from "./queryCache";

function buildReport(sql: string) {
  return ReportSchema.parse({
    version: 1,
    name: "Redaction test report",
    parameters: [],
    dataSources: [{ id: "q1", name: "Customers", dataSourceId: "ds1", sql }],
    pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
  });
}

describe("runReportWithProof — column redaction on lake sources", () => {
  it("redacts a pii column for a non-admin viewer with no allowlisted role", async () => {
    lakeTableSchema = [
      { name: "id", type: "text" },
      { name: "email", type: "text", sensitivity: "pii", unredactedForRoles: [] },
    ];
    const report = buildReport("SELECT id, email FROM customers ORDER BY id -- t1");
    const { dataset } = await runReportWithProof({ report, params: {}, tenantId: "t1", viewer: { id: "u1", isAdmin: false, roles: [] } });
    expect(dataset.q1).toEqual([
      { id: "1", email: "•••••" },
      { id: "2", email: "•••••" },
    ]);
  });

  it("never redacts for an admin viewer", async () => {
    lakeTableSchema = [
      { name: "id", type: "text" },
      { name: "email", type: "text", sensitivity: "pii", unredactedForRoles: [] },
    ];
    const report = buildReport("SELECT id, email FROM customers ORDER BY id -- t2");
    const { dataset } = await runReportWithProof({ report, params: {}, tenantId: "t1", viewer: { id: "admin1", isAdmin: true, roles: [] } });
    expect(dataset.q1).toEqual([
      { id: "1", email: "alice@example.com" },
      { id: "2", email: "bob@example.com" },
    ]);
  });

  it("does not redact for a viewer whose role is in the column's unredactedForRoles", async () => {
    lakeTableSchema = [
      { name: "id", type: "text" },
      { name: "email", type: "text", sensitivity: "pii", unredactedForRoles: ["finance"] },
    ];
    const report = buildReport("SELECT id, email FROM customers ORDER BY id -- t3");
    const { dataset } = await runReportWithProof({ report, params: {}, tenantId: "t1", viewer: { id: "u2", isAdmin: false, roles: ["finance"] } });
    expect(dataset.q1[0].email).toBe("alice@example.com");
  });

  it("still redacts for a viewer whose role is NOT in the column's unredactedForRoles", async () => {
    lakeTableSchema = [
      { name: "id", type: "text" },
      { name: "email", type: "text", sensitivity: "pii", unredactedForRoles: ["finance"] },
    ];
    const report = buildReport("SELECT id, email FROM customers ORDER BY id -- t4");
    const { dataset } = await runReportWithProof({ report, params: {}, tenantId: "t1", viewer: { id: "u3", isAdmin: false, roles: ["sales"] } });
    expect(dataset.q1[0].email).toBe("•••••");
  });

  it("does not redact for a SYSTEM_RUN — a lake pipeline filling a table", async () => {
    lakeTableSchema = [
      { name: "id", type: "text" },
      { name: "email", type: "text", sensitivity: "pii", unredactedForRoles: [] },
    ];
    const report = buildReport("SELECT id, email FROM customers ORDER BY id -- t5");
    const { dataset } = await runReportWithProof({ report, params: {}, tenantId: "t1", viewer: SYSTEM_RUN });
    expect(dataset.q1[0].email).toBe("alice@example.com");
  });

  describe("redaction never corrupts the shared query cache", () => {
    const CACHE_SQL = "SELECT id, email FROM customers ORDER BY id -- cache-corruption-check";
    beforeEach(() => bustForDataSource("t1", "ds1"));

    it("an admin's cached raw rows are still raw after a non-admin reads the same cache entry", async () => {
      lakeTableSchema = [
        { name: "id", type: "text" },
        { name: "email", type: "text", sensitivity: "pii", unredactedForRoles: [] },
      ];
      const report = buildReport(CACHE_SQL);

      const adminFirst = await runReportWithProof({ report, params: {}, tenantId: "t1", viewer: { id: "admin1", isAdmin: true, roles: [] } });
      expect(adminFirst.dataset.q1[0].email).toBe("alice@example.com");

      // Cache hit on the exact same (tenant, source, sql, params) key — must
      // still redact for THIS viewer even though the cached rows are raw.
      const memberSecond = await runReportWithProof({ report, params: {}, tenantId: "t1", viewer: { id: "u1", isAdmin: false, roles: [] } });
      expect(memberSecond.dataset.q1[0].email).toBe("•••••");

      // The cache entry itself must be untouched by the member's read — a
      // second admin read (same cache entry) must still see the raw value.
      const adminThird = await runReportWithProof({ report, params: {}, tenantId: "t1", viewer: { id: "admin1", isAdmin: true, roles: [] } });
      expect(adminThird.dataset.q1[0].email).toBe("alice@example.com");
    });
  });
});
