/**
 * POST /api/schedules let any role create a standing job that emails a
 * report to recipients of its choosing, viewers and viewer-role API keys
 * included. GET listed every Schedule row, so watchers, digests and briefs
 * showed up on the delivery-only Schedules page.
 *
 * The real tenantWhere() / requireReportInScope() run here; only the caller
 * identity is stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ user: null as any }));

vi.mock("@/lib/db", () => ({
  prisma: {
    schedule: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({ id: "s-new" })) },
    report: { findFirst: vi.fn(async () => ({ id: "rA", createdById: "u-owner", name: "Sales" })) },
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn(async () => h.user) };
});
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));

import { prisma } from "@/lib/db";
import { GET, POST } from "./route";

const session = (role: string) => ({ id: "u1", email: "u@test.dev", role, tenantId: "t1" });
const viewerKey = { id: "apikey:k1", email: "apikey+curf_x@curf.local", role: "viewer", tenantId: "t1", viaApiKey: true, apiKeyId: "k1" };
const create = () => POST(new NextRequest("http://localhost:3100/api/schedules", {
  method: "POST",
  body: JSON.stringify({ reportId: "rA", name: "Weekly", cron: "0 7 * * 1", recipients: ["attacker@example.com"] }),
}));
const list = (qs = "") => GET(new NextRequest("http://localhost:3100/api/schedules" + qs));

beforeEach(() => {
  vi.clearAllMocks();
  h.user = session("developer");
});

describe("POST /api/schedules — viewer and executive are read-only", () => {
  for (const [who, user] of [
    ["a viewer session", session("viewer")],
    ["an executive session", session("executive")],
    ["a viewer-role API key", viewerKey],
  ] as const) {
    it(`403s ${who} and creates nothing`, async () => {
      h.user = user;
      const res = await create();
      expect(res.status).toBe(403);
      expect(prisma.schedule.create).not.toHaveBeenCalled();
    });
  }

  it("lets a developer create one", async () => {
    const res = await create();
    expect(res.status).toBe(200);
    expect(prisma.schedule.create).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/schedules — delivery schedules only", () => {
  it("filters on kind, tenant-scoped", async () => {
    await list();
    expect(vi.mocked(prisma.schedule.findMany).mock.calls[0][0]).toMatchObject({
      where: { kind: "delivery", tenantId: "t1" },
    });
  });

  it("keeps the kind filter when narrowing to one report, and viewers can still read the list", async () => {
    h.user = session("viewer");
    expect((await list("?reportId=rA")).status).toBe(200);
    expect(vi.mocked(prisma.schedule.findMany).mock.calls[0][0]).toMatchObject({
      where: { kind: "delivery", tenantId: "t1", reportId: "rA" },
    });
  });
});
