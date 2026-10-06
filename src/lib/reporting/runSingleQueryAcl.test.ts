/**
 * runSingleQuery (the designer's "Run query" button, and the other single-
 * query previews) never checked data-source visibility: a developer could
 * preview rows from a role-restricted or owner-only source, or ATTACH one
 * into a JOIN, that the report viewer itself would have hidden. Given a
 * viewer it now applies canSeeDataSource to the primary and to every
 * ATTACHed source before any connection opens. Omitted, it runs unfiltered.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const h = vi.hoisted(() => ({ opened: [] as string[], rows: {} as Record<string, any> }));

// The real driver, counting every connection the runner opens.
vi.mock("better-sqlite3", async (importOriginal) => {
  const Real = ((await importOriginal<any>()).default) as any;
  class CountingDatabase extends Real {
    constructor(file: string, opts?: unknown) {
      h.opened.push(file);
      super(file, opts);
    }
  }
  return { default: CountingDatabase };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    dataSource: {
      findFirst: vi.fn(async ({ where }: any) => (h.rows[where.id]?.tenantId === where.tenantId ? h.rows[where.id] : null)),
    },
  },
}));

import Database from "better-sqlite3";
import { runSingleQuery, SYSTEM_RUN, type RunViewer } from "./runner";
import type { DataSourceDef } from "./schema";
import { tenantUploadRoot } from "@/lib/connections/excelImport";

const stamp = `${process.pid}-${Date.now()}`;
// The runner only opens a workspace's own files (lib/connections/sqlitePath.ts),
// so the fixtures live in t1's upload folder under a throwaway lake dir.
vi.stubEnv("CURF_LAKE_DIR", fs.mkdtempSync(path.join(os.tmpdir(), "curf-rsq-acl-")));
const UPLOADS = path.join(tenantUploadRoot("t1"), "uploads");
const SALES_DB = path.join(UPLOADS, `sales-${stamp}.db`);
const TARGETS_DB = path.join(UPLOADS, `targets-${stamp}.db`);

beforeAll(() => {
  fs.mkdirSync(UPLOADS, { recursive: true });
  const sales = new Database(SALES_DB);
  sales.exec(`CREATE TABLE sales (region TEXT, amount INTEGER); INSERT INTO sales VALUES ('north', 10), ('south', 20);`);
  sales.close();
  const targets = new Database(TARGETS_DB);
  targets.exec(`CREATE TABLE targets (region TEXT, goal INTEGER); INSERT INTO targets VALUES ('north', 15), ('south', 25);`);
  targets.close();
});
afterAll(() => {
  for (const f of [SALES_DB, TARGETS_DB]) { try { fs.unlinkSync(f); } catch { /* best-effort */ } }
  vi.unstubAllEnvs();
});

const source = (id: string, connection: string, acl: { visibleToRolesJson?: string; ownerUserId?: string | null }) => ({
  id, tenantId: "t1", kind: "sqlite", name: id, connection,
  visibleToRolesJson: acl.visibleToRolesJson ?? "[]", ownerUserId: acl.ownerUserId ?? null,
});

const salesQuery: DataSourceDef = { id: "q1", name: "Sales", dataSourceId: "ds-sales", sql: "SELECT region, amount FROM sales ORDER BY region" };
const joinQuery: DataSourceDef = {
  id: "q2", name: "Sales vs target", dataSourceId: "ds-sales",
  sql: "SELECT s.region, s.amount, t.goal FROM sales s JOIN tgt.targets t ON t.region = s.region ORDER BY s.region",
  attaches: [{ dataSourceId: "ds-targets", alias: "tgt" }],
};

const MEMBER: RunViewer = { id: "u-member", isAdmin: false, roles: ["sales"] };
const FINANCE: RunViewer = { id: "u-fin", isAdmin: false, roles: ["finance"] };
const ADMIN: RunViewer = { id: "u-admin", isAdmin: true, roles: [] };
const HIDDEN = "Hidden by visibility — you don't have access to this source.";

beforeEach(() => {
  h.opened = [];
  h.rows = {};
});

describe("runSingleQuery — data-source visibility", () => {
  it("rejects a role-restricted source for a viewer without the role, before opening it", async () => {
    h.rows["ds-sales"] = source("ds-sales", SALES_DB, { visibleToRolesJson: '["finance"]' });
    await expect(runSingleQuery(salesQuery, {}, MEMBER, "t1")).rejects.toThrow(HIDDEN);
    expect(h.opened).toEqual([]);
  });

  it("runs the same source for an admin (role mode has an admin bypass)", async () => {
    h.rows["ds-sales"] = source("ds-sales", SALES_DB, { visibleToRolesJson: '["finance"]' });
    expect(await runSingleQuery(salesQuery, {}, ADMIN, "t1")).toEqual([
      { region: "north", amount: 10 },
      { region: "south", amount: 20 },
    ]);
    // The counter sees the runner's opens, so the empty lists above mean something.
    expect(h.opened).toEqual([SALES_DB]);
  });

  it("rejects an owner-only source for an admin who isn't the owner", async () => {
    h.rows["ds-sales"] = source("ds-sales", SALES_DB, { ownerUserId: "u-owner" });
    await expect(runSingleQuery(salesQuery, {}, ADMIN, "t1")).rejects.toThrow(HIDDEN);
    expect(h.opened).toEqual([]);
  });

  it("rejects a JOIN whose ATTACHed source the viewer can't see, before opening either file", async () => {
    h.rows["ds-sales"] = source("ds-sales", SALES_DB, {});
    h.rows["ds-targets"] = source("ds-targets", TARGETS_DB, { visibleToRolesJson: '["finance"]' });
    await expect(runSingleQuery(joinQuery, {}, MEMBER, "t1"))
      .rejects.toThrow(`Attached source "tgt" is hidden by visibility — you don't have access.`);
    expect(h.opened).toEqual([]);
  });

  it("runs the JOIN for a viewer who can see the ATTACHed source", async () => {
    h.rows["ds-sales"] = source("ds-sales", SALES_DB, {});
    h.rows["ds-targets"] = source("ds-targets", TARGETS_DB, { visibleToRolesJson: '["finance"]' });
    expect(await runSingleQuery(joinQuery, {}, FINANCE, "t1")).toEqual([
      { region: "north", amount: 10, goal: 15 },
      { region: "south", amount: 20, goal: 25 },
    ]);
  });

  it("as SYSTEM_RUN, runs unfiltered — restricted primary and ATTACHed source alike", async () => {
    h.rows["ds-sales"] = source("ds-sales", SALES_DB, { ownerUserId: "u-owner" });
    h.rows["ds-targets"] = source("ds-targets", TARGETS_DB, { visibleToRolesJson: '["finance"]' });
    expect(await runSingleQuery(salesQuery, {}, SYSTEM_RUN, "t1")).toHaveLength(2);
    expect(await runSingleQuery(joinQuery, {}, SYSTEM_RUN, "t1")).toEqual([
      { region: "north", amount: 10, goal: 15 },
      { region: "south", amount: 20, goal: 25 },
    ]);
  });
});
