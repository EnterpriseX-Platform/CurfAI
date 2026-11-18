/**
 * The viewer's chart-type picker was a "view as" toggle with no way to keep the choice: a reader switched
 * a bar chart to a line, reloaded, and had the bar back. This route keeps it for everyone, one block at a
 * time on the STORED definition (the viewer may hold a role-trimmed copy), editors only, gated types by plan.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@curf.local", tenantId: "t1", role: "developer" } as any,
  row: null as any,
  updated: 1,
  gate: null as any,
}));

vi.mock("@/lib/db", () => {
  const tx = {
    report: { updateMany: vi.fn(async () => ({ count: h.updated })) },
    reportVersion: { create: vi.fn(async () => ({})) },
  };
  return {
    prisma: {
      report: { findFirst: vi.fn(async () => h.row) },
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      __tx: tx,
    },
  };
});
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireAdminOrEditor: vi.fn(async () => h.user) };
});
vi.mock("@/lib/audit", () => ({ persistAuditIn: vi.fn(async () => {}) }));
vi.mock("@/lib/featureGate", () => ({ featureGate: vi.fn(async () => h.gate) }));

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminOrEditor } from "@/lib/auth";
import { persistAuditIn } from "@/lib/audit";
import { featureGate } from "@/lib/featureGate";
import { POST } from "./route";

const tx = (prisma as any).__tx;
const chart = (id: string, chartType: string) => ({ id, type: "chart", x: 0, y: 0, w: 6, h: 6, config: { queryId: "q1", chartType, xField: "m", yFields: ["v"] } });
const definition = (blocks: unknown[]) => JSON.stringify({
  version: 1, name: "R", parameters: [], dataSources: [{ id: "q1", name: "q1", dataSourceId: "ds1", sql: "SELECT 1" }],
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks }],
});
const save = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/reports/r1/chart-type", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "r1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "u1", email: "u1@curf.local", tenantId: "t1", role: "developer" };
  h.row = { id: "r1", tenantId: "t1", name: "R", version: 3, definition: definition([chart("c1", "bar"), chart("c2", "pie")]) };
  h.updated = 1;
  h.gate = null;
});

describe("POST /api/reports/:id/chart-type", () => {
  it("keeps the new type on that block only, with a version of the one before and an audit row", async () => {
    const res = await save({ blockId: "c1", chartType: "line" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 4 });
    const written = JSON.parse(tx.report.updateMany.mock.calls[0][0].data.definition);
    expect(written.pages[0].blocks.map((b: any) => b.config.chartType)).toEqual(["line", "pie"]);
    expect(tx.report.updateMany.mock.calls[0][0].where).toEqual({ id: "r1", tenantId: "t1", version: 3 });
    expect(tx.reportVersion.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", reportId: "r1", version: 3, definition: h.row.definition });
    expect(vi.mocked(persistAuditIn).mock.calls[0][1]).toMatchObject({ kind: "report.update", target: "r1", meta: { blockId: "c1", chartType: { from: "bar", to: "line" } } });
  });

  it("looks the report up in the caller's workspace only", async () => {
    await save({ blockId: "c1", chartType: "line" });
    expect(vi.mocked(prisma.report.findFirst).mock.calls[0][0]).toMatchObject({ where: { id: "r1", tenantId: "t1" } });
  });

  it("refuses a reader who cannot edit, and writes nothing", async () => {
    vi.mocked(requireAdminOrEditor).mockResolvedValueOnce(NextResponse.json({ error: "Forbidden" }, { status: 403 }) as any);
    const res = await save({ blockId: "c1", chartType: "line" });
    expect(res.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a block that is not a chart in this report, and an unknown chart type", async () => {
    expect((await save({ blockId: "nope", chartType: "line" })).status).toBe(404);
    expect((await save({ blockId: "c1", chartType: "hologram" })).status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("holds a gated type to the plan, the same as a full save", async () => {
    h.gate = NextResponse.json({ error: "Upgrade" }, { status: 402 });
    const res = await save({ blockId: "c1", chartType: "waterfall" });
    expect(res.status).toBe(402);
    expect(vi.mocked(featureGate).mock.calls[0][1]).toBe("viz.chart.waterfall");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("answers 409 when the report was saved in between, and the transaction rolls back", async () => {
    h.updated = 0;
    const res = await save({ blockId: "c1", chartType: "line" });
    expect(res.status).toBe(409);
    expect(tx.reportVersion.create).not.toHaveBeenCalled();
  });

  it("does nothing when the type is already the saved one", async () => {
    const res = await save({ blockId: "c1", chartType: "bar" });
    expect(await res.json()).toMatchObject({ ok: true, unchanged: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
