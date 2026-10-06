/**
 * The lake writers that persist a report query's result — a materialized view
 * refresh and a REST pull — used to call runReport(), which reports a FAILED
 * query as an empty array. So:
 *
 *   - refreshing a view whose SQL had stopped working (a renamed column, a
 *     dialect the engine doesn't speak) replaced the last good table with an
 *     empty one and marked the view healthy — found on a DuckDB tenant whose
 *     weekly_signups view failed to bind and came back "ok, 0 rows";
 *   - a "replace" pull during an upstream API outage called
 *     createOrReplaceTable(rows: []) — wiping the customer's table — and
 *     recorded success. (The try/catch around runReport never fired: it
 *     doesn't throw.)
 *
 * A query that genuinely returns no rows is still a valid refresh. (Pipeline
 * steps are covered in pipelinesGovernance.test.ts — pipelines.ts is paid-only.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  provenance: {} as Record<string, any>,
  rows: [] as any[],
  webhooks: [] as any[],
}));

const prismaMock = vi.hoisted(() => ({
  materializedView: {
    findUnique: vi.fn(),
    update: vi.fn(async () => ({})),
  },
  lakeTable: {
    findUnique: vi.fn(async () => null),
    // sourceGovernance.ts's loadDerivationSources — refreshMaterializedView now
    // also inherits tags from the tables its SQL reads. No governance-tagged
    // fixtures here, so an empty catalog is the right stand-in.
    findMany: vi.fn(async () => []),
    upsert: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({})),
  },
  lakePull: {
    findUnique: vi.fn(),
    update: vi.fn(async () => ({})),
  },
  dataSource: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/reporting/runner", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
  runReportWithProof: vi.fn(async ({ report }: any) => {
    const id = report.dataSources[0].id;
    return { dataset: { [id]: h.rows }, provenance: { [id]: h.provenance } };
  }),
}));
vi.mock("./tables", () => ({
  createOrReplaceTable: vi.fn(async ({ rows }: any) => ({
    rowCount: rows.length,
    columns: Object.keys(rows[0] ?? {}).map((name) => ({ name, type: "text" })),
  })),
  appendRows: vi.fn(async ({ rows }: any) => ({ added: rows.length })),
}));
vi.mock("./bust", () => ({ bustLakeCacheForTenant: vi.fn(async () => {}) }));
vi.mock("./storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage")>();
  return { ...actual, lakeFileSize: () => 0 };
});
vi.mock("@/lib/webhooks", () => ({ emitWebhook: vi.fn((e: any) => { h.webhooks.push(e); }) }));
vi.mock("@/ee", () => ({ ee: {} }));
vi.mock("./parseFile", () => ({ parseUpload: vi.fn() }));

import { refreshMaterializedView } from "./materialize";
import { runLakePull } from "./restPull";
import { createOrReplaceTable, appendRows } from "./tables";

const FAILURE = "Binder Error: Referenced column \"nope\" not found";

beforeEach(() => {
  vi.clearAllMocks();
  h.provenance = {};
  h.rows = [];
  h.webhooks.length = 0;
  prismaMock.materializedView.findUnique.mockResolvedValue({
    id: "mvid000000001", tenantId: "t1", name: "weekly", sql: "SELECT 1", dataSourceId: "ds1", createdById: null,
  });
  prismaMock.dataSource.findFirst.mockResolvedValue({ id: "ds1", kind: "rest", tenantId: "t1" });
  prismaMock.lakePull.findUnique.mockResolvedValue({
    id: "pull0000000001", tenantId: "t1", name: "orders pull", tableName: "orders", strategy: "replace",
    dataSourceId: "ds1", createdById: null,
    requestJson: JSON.stringify({ method: "GET", path: "/orders", jsonPath: "$" }),
  });
});

describe("refreshMaterializedView — a failed query must not empty the view", () => {
  it("fails the refresh, leaves the existing table alone, and records why", async () => {
    h.provenance = { executionError: FAILURE };
    const result = await refreshMaterializedView("mvid000000001");

    expect(result.status).toBe("failed");
    expect(result.error).toContain(FAILURE);
    expect(createOrReplaceTable).not.toHaveBeenCalled(); // the last good mv_ table is still there
    expect(prismaMock.lakeTable.upsert).not.toHaveBeenCalled();
    expect(prismaMock.materializedView.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastStatus: "failed", lastError: expect.stringContaining(FAILURE) }),
    }));
    expect(h.webhooks.map((w) => w.event)).toEqual(["lake.mv.failed"]);
  });

  it("still refreshes to an empty table when the query genuinely returns no rows", async () => {
    h.rows = [];
    const result = await refreshMaterializedView("mvid000000001");
    expect(result.status).toBe("ok");
    expect(result.rowCount).toBe(0);
    expect(createOrReplaceTable).toHaveBeenCalledTimes(1);
  });

  it("refreshes normally when the query returns rows", async () => {
    h.rows = [{ week: "2026-W01", signups: 3 }];
    const result = await refreshMaterializedView("mvid000000001");
    expect(result).toMatchObject({ status: "ok", rowCount: 1 });
  });
});

describe("runLakePull — an upstream failure must not wipe the table", () => {
  it("replace strategy: fails the pull instead of replacing the table with nothing", async () => {
    h.provenance = { executionError: "HTTP 503 from upstream" };
    const result = await runLakePull("pull0000000001");

    expect(result).toEqual({ rowsWritten: 0, status: "failed" });
    expect(createOrReplaceTable).not.toHaveBeenCalled();
    expect(prismaMock.lakePull.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastStatus: "failed", lastError: expect.stringContaining("HTTP 503") }),
    }));
  });

  it("append strategy: reports the failure as a failure, not a quiet 'skipped'", async () => {
    prismaMock.lakePull.findUnique.mockResolvedValue({
      id: "pull0000000001", tenantId: "t1", name: "orders pull", tableName: "orders", strategy: "append",
      dataSourceId: "ds1", createdById: null,
      requestJson: JSON.stringify({ method: "GET", path: "/orders" }),
    });
    h.provenance = { executionError: "connect ETIMEDOUT" };
    const result = await runLakePull("pull0000000001");
    expect(result.status).toBe("failed");
    expect(appendRows).not.toHaveBeenCalled();
  });

  it("replace strategy still replaces when the source genuinely has no rows", async () => {
    h.rows = [];
    const result = await runLakePull("pull0000000001");
    expect(result.status).toBe("ok");
    expect(createOrReplaceTable).toHaveBeenCalledWith(expect.objectContaining({ tableName: "orders", rows: [] }));
  });

  it("replace strategy writes the rows it got", async () => {
    h.rows = [{ id: 1 }, { id: 2 }];
    const result = await runLakePull("pull0000000001");
    expect(result).toEqual({ rowsWritten: 2, status: "ok" });
    expect(createOrReplaceTable).toHaveBeenCalledWith(expect.objectContaining({ rows: [{ id: 1 }, { id: 2 }] }));
  });
});
