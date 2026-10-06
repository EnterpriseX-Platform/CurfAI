/**
 * KPI Replay read every saved run of the report as stored, whoever made it,
 * and looked the KPI up in the full definition: a viewer could replay a KPI
 * hidden from their roles, or points from an admin's load of a source they
 * can't see. The block is now found in the caller's view and each run is
 * read as the caller (savedRunReader), so neither yields a point.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ user: null as any, roles: [] as string[] }));

vi.mock("@/lib/db", () => ({
  prisma: {
    report: { findFirst: vi.fn() },
    reportRun: { findMany: vi.fn() },
    dataSource: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn(async () => h.user), getUserRoles: vi.fn(async () => h.roles) };
});

import { prisma } from "@/lib/db";
import { GET } from "./route";

const DEFINITION = JSON.stringify({
  version: 1, name: "Revenue", parameters: [],
  dataSources: [
    { id: "q", name: "Revenue", dataSourceId: "ds1", sql: "SELECT SUM(amount) AS v FROM sales" },
    { id: "qHidden", name: "Payroll", dataSourceId: "ds2", sql: "SELECT SUM(pay) AS v FROM hr" },
  ],
  pages: [{
    id: "p1", size: "A4", orientation: "portrait",
    blocks: [
      { id: "b1", type: "kpi", x: 0, y: 0, w: 4, h: 3, config: { queryId: "q", label: "Revenue", valueField: "v", format: "number" } },
      { id: "b-hidden", type: "kpi", x: 4, y: 0, w: 4, h: 3, visibleToRoles: ["probe-nobody"],
        config: { queryId: "qHidden", label: "Payroll", valueField: "v", format: "number" } },
    ],
  }],
});

const SOURCES: Record<string, object> = {
  "Sales DB": { id: "ds1", kind: "sqlite", ownerUserId: null, visibleToRolesJson: "[]" },
  "HR DB": { id: "ds9", kind: "sqlite", ownerUserId: null, visibleToRolesJson: '["probe-nobody"]' },
};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const savedRun = (id: string, createdAt: Date, source: string, v: number) => ({
  id, createdAt, params: "{}",
  dataset: JSON.stringify({ q: [{ v }] }),
  provenance: JSON.stringify({ q: { queryId: "q", queryName: "Revenue", queryHash: "qh", dataHash: `dh-${id}`, rowCount: 1, runAt: createdAt.toISOString(), dataSourceName: source, dataSourceKind: "sqlite" } }),
});
const get = (blockId: string) => GET(
  new NextRequest(`http://localhost:3100/api/reports/r1/kpi-history?blockId=${blockId}`),
  { params: { id: "r1" } },
);

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "u1", email: "m@test.dev", role: "viewer", tenantId: "t1" };
  h.roles = ["finance"];
  vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", tenantId: "t1", definition: DEFINITION } as any);
  vi.mocked(prisma.dataSource.findUnique).mockImplementation((async (args: any) => SOURCES[args.where.tenantId_name.name] ?? null) as any);
  const runs = [
    savedRun("run-hr", daysAgo(1), "HR DB", 999),
    savedRun("run-sales", daysAgo(2), "Sales DB", 120),
  ];
  // First call: ids + timestamps; second: the chosen runs' snapshots.
  vi.mocked(prisma.reportRun.findMany).mockImplementation((async (args: any) =>
    args.select.dataset ? runs : runs.map(({ id, createdAt }) => ({ id, createdAt }))) as any);
});

describe("GET /api/reports/:id/kpi-history — as the caller", () => {
  it("a KPI hidden from the caller is a 404 'KPI block not found', and no run is read", async () => {
    const res = await get("b-hidden");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "KPI block not found" });
    expect(prisma.reportRun.findMany).not.toHaveBeenCalled();
  });

  it("a run whose provenance names a source the caller can't see yields no point", async () => {
    const res = await get("b1");
    expect(res.status).toBe(200);
    const { points } = await res.json();
    expect(points).toEqual([expect.objectContaining({ runId: "run-sales", value: 120, dataHash: "dh-run-sales" })]);
  });
});
