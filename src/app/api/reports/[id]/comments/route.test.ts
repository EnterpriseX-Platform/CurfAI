/**
 * The comments list returned every comment on the report, including the ones
 * on a block hidden from the caller's roles, and a comment is about what its
 * block shows. GET now leaves those out, keeping report-level comments and
 * ones on visible or since-deleted blocks, and POST refuses a comment (or a
 * reply) on a hidden block, which would also notify people about it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ user: null as any, roles: [] as string[] }));

vi.mock("@/lib/db", () => ({
  prisma: {
    report: { findFirst: vi.fn() },
    comment: { findMany: vi.fn(async () => []), findFirst: vi.fn(), create: vi.fn(async () => ({ id: "c-new" })) },
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn(async () => h.user), getUserRoles: vi.fn(async () => h.roles) };
});
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/delivery/dispatch", () => ({ dispatchDelivery: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({ emitWebhook: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db";
import { GET, POST } from "./route";

const DEFINITION = JSON.stringify({
  version: 1, name: "Revenue", parameters: [],
  dataSources: [
    { id: "q", name: "Revenue", dataSourceId: "ds1", sql: "SELECT SUM(x) AS v FROM t" },
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
const comment = (id: string, blockId: string | null) => ({
  id, blockId, cellKey: null, body: `note ${id}`, proofHash: null, resolvedAt: null, parentId: null,
  mentionsJson: "[]", createdAt: new Date(), updatedAt: new Date(), author: { id: "u2", name: "Ann", email: "ann@test.dev" },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.roles = ["finance"];
  vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", definition: DEFINITION } as any);
  vi.mocked(prisma.comment.findMany).mockResolvedValue([
    comment("c-report", null),
    comment("c-visible", "b1"),
    comment("c-hidden", "b-hidden"),
    comment("c-deleted", "b-gone"),
  ] as any);
});

const list = async () => {
  const res = await GET(new NextRequest("http://localhost:3100/api/reports/r1/comments"), { params: { id: "r1" } });
  expect(res.status).toBe(200);
  return ((await res.json()).items as any[]).map((c) => c.id);
};

describe("GET /api/reports/:id/comments — comments on hidden blocks", () => {
  it("leaves out comments on a block hidden from the caller; keeps report-level, visible-block and since-deleted-block ones", async () => {
    h.user = { id: "u1", email: "m@test.dev", role: "viewer", tenantId: "t1" };
    expect(await list()).toEqual(["c-report", "c-visible", "c-deleted"]);
  });

  it("an admin, who sees every block, gets every comment", async () => {
    h.user = { id: "u-admin", email: "a@test.dev", role: "admin", tenantId: "t1" };
    expect(await list()).toEqual(["c-report", "c-visible", "c-hidden", "c-deleted"]);
  });
});

describe("POST /api/reports/:id/comments — a hidden block can't be commented on", () => {
  const post = (body: Record<string, unknown>) => POST(
    new NextRequest("http://localhost:3100/api/reports/r1/comments", { method: "POST", body: JSON.stringify(body) }),
    { params: { id: "r1" } },
  );
  beforeEach(() => {
    h.user = { id: "u1", email: "m@test.dev", role: "viewer", tenantId: "t1" };
  });

  it("refuses a comment on a hidden block with the same 404 as a missing one, creating nothing", async () => {
    const res = await post({ blockId: "b-hidden", body: "What happened here?" });
    expect(res.status).toBe(404);
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });

  it("refuses a reply whose parent sits on a hidden block", async () => {
    vi.mocked(prisma.comment.findFirst).mockResolvedValueOnce({ blockId: "b-hidden" } as any);
    const res = await post({ blockId: "b1", parentId: "c-hidden", body: "Agreed" });
    expect(res.status).toBe(404);
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });
});
