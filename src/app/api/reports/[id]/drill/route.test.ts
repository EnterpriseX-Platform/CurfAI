/**
 * Drill-through ran its target query with no viewer, which the runner treats
 * as the system, and handed the rows straight back: a viewer-role API key
 * clicking a bar got detail rows from role-restricted and owner-only sources
 * the chart itself had hidden from it. The route now runs as the caller, so a
 * source the caller can't see comes back empty here too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ user: null as any, roles: [] as string[], rows: [] as any[], provenance: {} as Record<string, any> }));

vi.mock("@/lib/db", () => ({
  prisma: { report: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn(async () => h.user), getUserRoles: vi.fn(async () => h.roles) };
});
vi.mock("@/lib/reporting/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
  runReportWithProof: vi.fn(async () => ({ dataset: { detail: h.rows }, provenance: { detail: h.provenance } })),
}));
vi.mock("@/lib/rateLimit", () => ({ ensureLimit: vi.fn(() => null) }));

import { prisma } from "@/lib/db";
import { getUserRoles } from "@/lib/auth";
import { runReportWithProof } from "@/lib/reporting/runner";
import { POST } from "./route";

const DEFINITION = JSON.stringify({
  version: 1, name: "Spend", parameters: [],
  dataSources: [
    { id: "byChannel", name: "By channel", dataSourceId: "ds1", sql: "SELECT channel, SUM(spend) AS spend FROM t GROUP BY 1" },
    { id: "detail", name: "Detail", dataSourceId: "ds2", sql: "SELECT * FROM t WHERE channel = :channel" },
  ],
  pages: [{
    id: "p1", size: "A4", orientation: "portrait",
    blocks: [{
      id: "b1", type: "chart", x: 0, y: 0, w: 6, h: 4,
      config: { queryId: "byChannel", chartType: "bar", xField: "channel", yFields: ["spend"], drilldown: { queryId: "detail", filterParam: "channel" } },
    }],
  }],
});
const post = () => POST(
  new NextRequest("http://localhost:3100/api/reports/r1/drill", { method: "POST", body: JSON.stringify({ blockId: "b1", value: "Display" }) }),
  { params: { id: "r1" } },
);
const runCtx = () => vi.mocked(runReportWithProof).mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  h.roles = [];
  h.rows = [];
  h.provenance = {};
  vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", tenantId: "t1", name: "Spend", definition: DEFINITION } as any);
});

describe("POST /api/reports/:id/drill — runs as the caller", () => {
  it("a viewer-role API key runs as the key, and a source hidden from it returns no rows", async () => {
    h.user = { id: "apikey:k1", email: "apikey+curf_x@curf.local", role: "viewer", tenantId: "t1", viaApiKey: true, apiKeyId: "k1" };
    h.provenance = { accessDeniedNote: "Hidden by visibility — you don't have access to this source." };

    const res = await post();
    expect(res.status).toBe(200);
    expect(runCtx().viewer).toEqual({ id: "apikey:k1", isAdmin: false, roles: [] });
    expect(getUserRoles).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ rows: [], rowCount: 0, columns: [] });
  });

  it("a session member runs as themselves, custom roles included, and gets back exactly the runner's rows", async () => {
    h.user = { id: "u1", email: "m@test.dev", role: "viewer", tenantId: "t1" };
    h.roles = ["finance"];
    h.rows = [{ channel: "Display", campaign: "Q4 push", spend: 184 }];

    const res = await post();
    expect(runCtx().viewer).toEqual({ id: "u1", isAdmin: false, roles: ["finance"] });
    expect(await res.json()).toMatchObject({ rows: h.rows, rowCount: 1, columns: ["channel", "campaign", "spend"] });
  });

  it("runs only the drilldown target, with the clicked value bound", async () => {
    h.user = { id: "u-admin", email: "a@test.dev", role: "admin", tenantId: "t1" };
    await post();
    expect(runCtx().viewer).toEqual({ id: "u-admin", isAdmin: true, roles: [] });
    expect(runCtx().report.dataSources.map((d) => d.id)).toEqual(["detail"]);
    expect(runCtx().params).toMatchObject({ channel: "Display" });
  });
});

describe("POST /api/reports/:id/drill — a block hidden from the caller", () => {
  const GATED = JSON.stringify({
    version: 1, name: "Spend", parameters: [],
    dataSources: [
      { id: "byChannel", name: "By channel", dataSourceId: "ds1", sql: "SELECT channel, SUM(spend) AS spend FROM t GROUP BY 1" },
      { id: "detail", name: "Detail", dataSourceId: "ds2", sql: "SELECT * FROM t WHERE channel = :channel" },
      { id: "salaries", name: "Salaries", dataSourceId: "ds3", sql: "SELECT dept, SUM(pay) AS pay FROM hr GROUP BY 1" },
      { id: "salaryDetail", name: "Salary detail", dataSourceId: "ds3", sql: "SELECT * FROM hr WHERE dept = :dept" },
    ],
    pages: [{
      id: "p1", size: "A4", orientation: "portrait",
      blocks: [
        { id: "b1", type: "chart", x: 0, y: 0, w: 6, h: 4,
          config: { queryId: "byChannel", chartType: "bar", xField: "channel", yFields: ["spend"], drilldown: { queryId: "detail", filterParam: "channel" } } },
        { id: "b-hidden", type: "chart", x: 6, y: 0, w: 6, h: 4, visibleToRoles: ["probe-nobody"],
          config: { queryId: "salaries", chartType: "bar", xField: "dept", yFields: ["pay"], drilldown: { queryId: "salaryDetail", filterParam: "dept" } } },
      ],
    }],
  });
  const drill = (blockId: string) => POST(
    new NextRequest("http://localhost:3100/api/reports/r1/drill", { method: "POST", body: JSON.stringify({ blockId, value: "Exec" }) }),
    { params: { id: "r1" } },
  );

  beforeEach(() => {
    h.user = { id: "u1", email: "m@test.dev", role: "viewer", tenantId: "t1" };
    h.roles = ["finance"];
    vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", tenantId: "t1", name: "Spend", definition: GATED } as any);
  });

  it("drilling a hidden block is a 404 'Block not found', and nothing runs", async () => {
    const res = await drill("b-hidden");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Block not found" });
    expect(runReportWithProof).not.toHaveBeenCalled();
  });

  it("the visible block beside it still drills, on its own target only", async () => {
    const res = await drill("b1");
    expect(res.status).toBe(200);
    expect(runCtx().report.dataSources.map((d) => d.id)).toEqual(["detail"]);
    // No blocks at all: the hidden one can't ride along, and the runner doesn't
    // take the target for a drill-only query and skip it (lib/reporting/drill.ts).
    expect(runCtx().report.pages).toEqual([]);
  });
});

describe("POST /api/reports/:id/drill — tables, KPIs and the report's scope", () => {
  const MORE = JSON.stringify({
    version: 1, name: "Spend", parameters: [],
    dataSources: [
      { id: "total", name: "Total", dataSourceId: "ds1", sql: "SELECT SUM(spend) AS spend FROM t" },
      { id: "byChannel", name: "By channel", dataSourceId: "ds1", sql: "SELECT channel, SUM(spend) AS spend FROM t GROUP BY 1" },
      { id: "detail", name: "Detail", dataSourceId: "ds2", sql: "SELECT * FROM t WHERE channel = :channel" },
    ],
    pages: [{
      id: "p1", size: "A4", orientation: "portrait",
      blocks: [
        { id: "k1", type: "kpi", x: 0, y: 0, w: 3, h: 3, config: { queryId: "total", label: "Spend", valueField: "spend", drilldown: { queryId: "detail", title: "Every line" } } },
        { id: "t1", type: "table", x: 0, y: 3, w: 6, h: 4, config: { queryId: "byChannel", columns: [{ key: "channel", label: "Channel", type: "string" }], drilldown: { queryId: "detail", filterParam: "channel" } } },
      ],
    }],
  });
  const send = (blockId: string, value: unknown) => POST(
    new NextRequest("http://localhost:3100/api/reports/r1/drill", { method: "POST", body: JSON.stringify({ blockId, value }) }),
    { params: { id: "r1" } },
  );
  beforeEach(() => {
    h.user = { id: "u1", email: "m@test.dev", role: "viewer", tenantId: "t1" };
    vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", tenantId: "t1", name: "Spend", definition: MORE } as any);
  });

  it("a KPI shows the rows behind the whole number: nothing bound, no filter shown", async () => {
    const res = await send("k1", null);
    expect(res.status).toBe(200);
    expect(runCtx().params).not.toHaveProperty("channel");
    expect(await res.json()).toMatchObject({ title: "Every line", filterParam: null, filterValue: null });
  });

  it("a table row binds the clicked value", async () => {
    expect((await send("t1", "Search")).status).toBe(200);
    expect(runCtx().params).toMatchObject({ channel: "Search" });
  });
});
