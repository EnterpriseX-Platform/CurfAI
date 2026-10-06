/**
 * The report data API ran every query in the report and returned them all.
 * So a viewer-role API key read the rows behind a table the author had hidden
 * from its role (visibleToRoles). Verified live on 2026-09-24: all 15
 * "Top 15 products" rows came back from /api/v1/reports/:id/data.
 *
 * The real routes, runReportForApi() and visibleReport() run here. Only the
 * caller, their custom role slugs and the query rows are stubbed. The stub
 * runner returns rows for exactly the queries it is handed, like the real one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ user: null as any, roles: [] as string[] }));

vi.mock("@/lib/db", () => ({
  prisma: {
    report: { findFirst: vi.fn() },
    reportRun: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn(async () => h.user), getUserRoles: vi.fn(async () => h.roles) };
});
vi.mock("@/lib/rateLimit", () => ({ ensureLimit: vi.fn(() => null) }));
vi.mock("@/lib/reporting/runner", async (importOriginal) => {
  const ROWS: Record<string, unknown[]> = { q_salaries: [{ name: "Alice", salary: 123456 }], q_headcount: [{ team: "Ops", people: 12 }] };
  return {
    ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
    runReportWithProof: vi.fn(async ({ report }: any) => ({
      dataset: Object.fromEntries(report.dataSources.map((q: any) => [q.id, ROWS[q.id]])),
      provenance: Object.fromEntries(report.dataSources.map((q: any) => [q.id, {}])),
    })),
  };
});

import { prisma } from "@/lib/db";
import { GET as v1Data } from "./route";
import { GET as internalRun } from "@/app/api/reports/[id]/run/route";

const col = (key: string, label: string) => ({ key, label, type: "string", align: "left", total: "none" });
const DEFINITION = JSON.stringify({
  version: 1, name: "People", parameters: [],
  dataSources: [
    { id: "q_salaries", name: "Salaries", dataSourceId: "ds1", sql: "SELECT 1" },
    { id: "q_headcount", name: "Headcount", dataSourceId: "ds1", sql: "SELECT 1" },
  ],
  pages: [{
    id: "p1", size: "A4", orientation: "portrait",
    blocks: [
      { id: "t_fin", type: "table", x: 0, y: 0, w: 12, h: 4, visibleToRoles: ["finance"], config: { queryId: "q_salaries", title: "Salaries", columns: [col("name", "Name"), col("salary", "Salary")] } },
      { id: "t_open", type: "table", x: 0, y: 4, w: 12, h: 4, config: { queryId: "q_headcount", title: "Headcount", columns: [col("team", "Team"), col("people", "People")] } },
    ],
  }],
});

const get = (route: typeof v1Data, path: string) => route(new NextRequest(`http://localhost:3100${path}`), { params: { id: "r1" } });
const recorded = () => vi.mocked(prisma.reportRun.create).mock.calls[0][0].data as any;

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "key-1", email: null, role: "viewer", tenantId: "t1", viaApiKey: true };
  h.roles = [];
  vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", tenantId: "t1", name: "People", definition: DEFINITION } as any);
});

describe("report data API — queries behind blocks hidden by role", () => {
  it("doesn't return the rows of a query only a hidden block uses", async () => {
    const body = await (await get(v1Data, "/api/v1/reports/r1/data")).json();
    expect(Object.keys(body.dataset)).toEqual(["q_headcount"]);
    expect(JSON.stringify(body)).not.toContain("Alice");
    // Not run at all, so not reported as a failed query either.
    expect(body.queryErrors).toEqual({});
  });

  it("the internal /run route the viewer re-runs through is covered too", async () => {
    const body = await (await get(internalRun, "/api/reports/r1/run")).json();
    expect(Object.keys(body.dataset)).toEqual(["q_headcount"]);
    expect(Object.keys(body.provenance)).toEqual(["q_headcount"]);
  });

  it("records the run as restricted, so it never becomes a KPI baseline", async () => {
    await get(v1Data, "/api/v1/reports/r1/data");
    expect(recorded()).toMatchObject({ status: "restricted", error: "1 of 2 queries were hidden from this viewer" });
    expect(recorded().dataset).not.toContain("Alice");
  });

  it("returns every query to an admin key", async () => {
    h.user = { ...h.user, role: "admin" };
    const body = await (await get(v1Data, "/api/v1/reports/r1/data")).json();
    expect(Object.keys(body.dataset).sort()).toEqual(["q_headcount", "q_salaries"]);
    expect(recorded().status).toBe("completed");
  });

  it("returns the hidden block's query to a signed-in viewer who holds the role", async () => {
    h.user = { id: "u-fin", email: "f@test.dev", role: "viewer", tenantId: "t1" };
    h.roles = ["finance"];
    const body = await (await get(v1Data, "/api/v1/reports/r1/data")).json();
    expect(body.dataset.q_salaries).toEqual([{ name: "Alice", salary: 123456 }]);
  });
});
