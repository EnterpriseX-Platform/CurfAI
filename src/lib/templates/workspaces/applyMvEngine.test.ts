/**
 * A template's materialized view is persisted and re-run on its cron, so its SQL
 * has to be the right spelling for the tenant's lake engine when it's applied.
 * b2b-saas's weekly_signups used strftime('%Y-W%W', created_at) — SQLite's
 * argument order, which fails to bind on DuckDB's TEXT columns; the view then
 * "refreshed" to an empty table (see runQueryStrict for that half of the story).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ engine: "sqlite" as "sqlite" | "duckdb", created: [] as any[] }));

vi.mock("@/lib/db", () => ({
  prisma: {
    dataSource: { findFirst: vi.fn(async () => ({ id: "ds1" })) },
    materializedView: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => { h.created.push(data); return { id: "mv1" }; }),
    },
  },
}));
vi.mock("@/lib/lake/tables", () => ({ createOrReplaceTable: vi.fn() }));
vi.mock("@/lib/lake/storage", () => ({ lakeFileSize: () => 0 }));
vi.mock("@/lib/billing", () => ({ requireReportQuota: vi.fn(), requireWatcherQuota: vi.fn() }));
vi.mock("@/lib/lake/tenantEngine", () => ({ tenantLakeEngine: vi.fn(async () => h.engine) }));

import { applyWorkspaceTemplate } from "./apply";
import { b2bSaasTemplate, type WorkspaceTemplate } from "./b2b-saas";

const user = { id: "u1", email: "u@test.dev", role: "admin", tenantId: "t1" } as any;
const onlyViews = (mvs: WorkspaceTemplate["materializedViews"]): WorkspaceTemplate =>
  ({ id: "x", name: "x", description: "", tables: [], reports: [], watchers: [], materializedViews: mvs });

beforeEach(() => { h.created.length = 0; h.engine = "sqlite"; });

describe("applyWorkspaceTemplate — a template view gets the tenant's engine", () => {
  const view = {
    name: "v", cron: "0 6 * * 1",
    sql: (engine: "sqlite" | "duckdb") => `SELECT '${engine}' AS spelled_for`,
  };

  it("passes 'sqlite' for a default-engine tenant", async () => {
    await applyWorkspaceTemplate(user, onlyViews([view]));
    expect(h.created[0].sql).toBe("SELECT 'sqlite' AS spelled_for");
  });

  it("passes 'duckdb' for a migrated tenant", async () => {
    h.engine = "duckdb";
    await applyWorkspaceTemplate(user, onlyViews([view]));
    expect(h.created[0].sql).toBe("SELECT 'duckdb' AS spelled_for");
  });

  it("stores a plain-string view exactly as written, whatever the engine", async () => {
    h.engine = "duckdb";
    await applyWorkspaceTemplate(user, onlyViews([{ name: "plain", cron: "", sql: "SELECT 1" }]));
    expect(h.created[0].sql).toBe("SELECT 1");
  });

  it("b2b-saas's weekly_signups is spelled differently per engine", async () => {
    const weekly = b2bSaasTemplate().materializedViews.find((m) => m.name === "weekly_signups")!;
    expect(typeof weekly.sql).toBe("function");
    const sql = weekly.sql as (e: "sqlite" | "duckdb") => string;
    expect(sql("sqlite")).toContain("strftime('%Y-W%W', created_at)");
    expect(sql("duckdb")).toContain("strftime(CAST(created_at AS TIMESTAMP), '%Y-W%W')");
    expect(sql("duckdb")).not.toContain("strftime('%Y-W%W'");
  });
});
