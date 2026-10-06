/**
 * Saving a report gates cross-source joins by plan: ATTACH (connector.attach)
 * and the in-runner hash join (connector.hash_join). Both are per-query
 * fields, dataSources[].attaches / .joins, but the save read them off the
 * report itself, where ReportSchema never keeps them. So neither gate ever
 * fired, and any plan could save (and so run) either kind of join.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  requireAdminOrEditor: vi.fn(async () => ({ id: "u1", tenantId: "t1", role: "developer" })),
  requireReportInScope: vi.fn(() => null),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    report: {
      findFirst: vi.fn(async () => ({ id: "r1", name: "R" })),
      update: vi.fn(async () => ({ id: "r1", version: 2 })),
    },
    // As Postgres would answer { tenantId, id in [...] }: ds-theirs is another workspace's.
    dataSource: {
      findMany: vi.fn(async ({ where }: any) =>
        ["ds1", "ds2"].filter((id) => where.tenantId === "t1" && where.id.in.includes(id)).map((id) => ({ id }))),
    },
  },
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/ee", () => ({ ee: {} }));
vi.mock("@/lib/featureGate", () => ({ featureGate: vi.fn(async () => null) }));

import { prisma } from "@/lib/db";
import { featureGate } from "@/lib/featureGate";
import { PUT } from "./route";

const query = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, dataSourceId: "ds1", sql: "SELECT 1", ...extra });
const definition = (dataSources: unknown[]) => ({
  version: 1, name: "R", parameters: [], dataSources,
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
});
const put = (dataSources: unknown[]) =>
  PUT(new NextRequest("http://localhost/api/reports/r1", {
    method: "PUT",
    body: JSON.stringify({ definition: definition(dataSources) }),
  }), { params: { id: "r1" } });
const gatedKeys = () => vi.mocked(featureGate).mock.calls.map((c) => c[1]);
const upgradeRequired = () => NextResponse.json({ error: "Upgrade required" }, { status: 402 });

beforeEach(() => vi.clearAllMocks());

describe("PUT /api/reports/:id — cross-source join gates", () => {
  it("refuses a hash join on a plan without connector.hash_join, and saves nothing", async () => {
    vi.mocked(featureGate).mockImplementation(async (_u, key) => (key === "connector.hash_join" ? upgradeRequired() : null));
    const res = await put([
      query("q_orders", { joins: [{ type: "left", queryId: "q_customers", on: { left: "customer_id", right: "id" }, alias: "c" }] }),
      query("q_customers"),
    ]);
    expect(res.status).toBe(402);
    expect(prisma.report.update).not.toHaveBeenCalled();
  });

  it("refuses an ATTACH on a plan without connector.attach, and saves nothing", async () => {
    vi.mocked(featureGate).mockImplementation(async (_u, key) => (key === "connector.attach" ? upgradeRequired() : null));
    const res = await put([query("q_campaigns", { attaches: [{ dataSourceId: "ds2", alias: "excel_kpis" }] })]);
    expect(res.status).toBe(402);
    expect(prisma.report.update).not.toHaveBeenCalled();
  });

  it("checks neither gate for a report without joins", async () => {
    const res = await put([query("q_plain")]);
    expect(res.status).toBe(200);
    expect(gatedKeys()).not.toContain("connector.attach");
    expect(gatedKeys()).not.toContain("connector.hash_join");
  });
});

// The save stored whatever source ids the body carried. The runner refuses
// to read another workspace's source, and now the save refuses to write one.
describe("PUT /api/reports/:id — only this workspace's data sources", () => {
  it("refuses a query naming another workspace's source, and saves nothing", async () => {
    const res = await put([query("q", { dataSourceId: "ds-theirs" })]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ dataSourceIds: ["ds-theirs"] });
    expect(vi.mocked(prisma.dataSource.findMany).mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1" } });
    expect(prisma.report.update).not.toHaveBeenCalled();
  });

  it("refuses an ATTACH of another workspace's source", async () => {
    const res = await put([query("q", { attaches: [{ dataSourceId: "ds-theirs", alias: "t" }] })]);
    expect(res.status).toBe(400);
    expect(prisma.report.update).not.toHaveBeenCalled();
  });

  it("saves this workspace's sources, and a placeholder that names none yet", async () => {
    const res = await put([query("q1"), query("q2", { dataSourceId: "__placeholder__:sales_db" })]);
    expect(res.status).toBe(200);
    expect(prisma.report.update).toHaveBeenCalledTimes(1);
  });
});
