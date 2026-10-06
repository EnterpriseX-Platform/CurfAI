/**
 * A viewer could download a table the report author hid from their role
 * (visibleToRoles): the viewer page filtered it out, this route didn't.
 * The real route, exportViewer() and renderCsv() run here. Only the caller,
 * their custom role slugs and the query rows are stubbed.
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
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/reporting/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
  runReportWithProof: vi.fn(async () => ({
    dataset: { q_salaries: [{ name: "Alice", salary: 123456 }], q_headcount: [{ team: "Ops", people: 12 }] },
    provenance: {},
  })),
}));

import { prisma } from "@/lib/db";
import { GET } from "./route";

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

const exportCsv = (query = "") => GET(
  new NextRequest(`http://localhost:3100/api/reports/r1/export/csv${query}`),
  { params: { id: "r1" } },
);

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "u-viewer", email: "v@test.dev", role: "viewer", tenantId: "t1" };
  h.roles = [];
  vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", tenantId: "t1", name: "People", definition: DEFINITION } as any);
});

describe("GET /api/reports/:id/export/csv — blocks hidden by role", () => {
  it("won't export a table hidden from the caller's roles, even by ?block=", async () => {
    const res = await exportCsv("?block=t_fin");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No table block to export as CSV" });
    expect(prisma.reportRun.create).not.toHaveBeenCalled();
  });

  it("exports the first table the caller can see", async () => {
    const res = await exportCsv();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Ops");
    expect(body).not.toContain("Alice");
  });

  it("exports the table to a caller with the role", async () => {
    h.roles = ["finance"];
    const res = await exportCsv("?block=t_fin");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Alice");
  });

  it("exports the table to an admin", async () => {
    h.user = { ...h.user, id: "u-admin", role: "admin" };
    const res = await exportCsv("?block=t_fin");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Alice");
  });

  it("an API key has no role slugs, so it doesn't get the table either", async () => {
    h.user = { id: "apikey:k1", email: "apikey+curf_x@curf.local", role: "viewer", tenantId: "t1", viaApiKey: true, apiKeyId: "k1" };
    h.roles = ["finance"]; // never read for a key
    expect((await exportCsv("?block=t_fin")).status).toBe(400);
  });
});
