/**
 * Removing a member who has accepted (offboarding). Found on the 2026-09-24
 * retest: the only delete route refused accepted members with 409 and the
 * Users page had no button, so a departed colleague could at most be
 * demoted to viewer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/ee", () => ({ ee: { billing: { syncSeats: vi.fn(async () => null) } } }));

const findUnique = vi.fn();
const count = vi.fn();
const del = vi.fn();
// What the member leaves behind — owner-only rows and API keys — handled in
// the same transaction as the membership delete.
const updateMany = {
  dataSource: vi.fn(async () => ({ count: 1 })),
  dashboard: vi.fn(async () => ({ count: 2 })),
  onScreenDisplay: vi.fn(async () => ({ count: 0 })),
  lakeTable: vi.fn(async () => ({ count: 1 })),
  apiKey: vi.fn(async () => ({ count: 3 })),
};
const tx = {
  membership: { delete: (...a: any[]) => del(...a) },
  dataSource: { updateMany: (...a: any[]) => (updateMany.dataSource as any)(...a) },
  dashboard: { updateMany: (...a: any[]) => (updateMany.dashboard as any)(...a) },
  onScreenDisplay: { updateMany: (...a: any[]) => (updateMany.onScreenDisplay as any)(...a) },
  lakeTable: { updateMany: (...a: any[]) => (updateMany.lakeTable as any)(...a) },
  apiKey: { updateMany: (...a: any[]) => (updateMany.apiKey as any)(...a) },
};
vi.mock("@/lib/db", () => ({
  prisma: {
    membership: { findUnique: (...a: any[]) => findUnique(...a), count: (...a: any[]) => count(...a) },
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  },
}));

import { requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { DELETE } from "./route";

const call = (id: string) =>
  DELETE(new NextRequest(`http://localhost:3100/api/admin/users/${id}/membership`, { method: "DELETE" }), { params: { id } });
const member = (over: Record<string, unknown> = {}) => ({
  role: "developer", user: { id: "u2", email: "leaver@example.com", passwordHash: "$2a$hash" }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({ id: "u1", tenantId: "t1", role: "admin" } as any);
  findUnique.mockResolvedValue(member());
  count.mockResolvedValue(2);
});

describe("DELETE /api/admin/users/[id]/membership", () => {
  it("removes an accepted member from this workspace only, and audits it", async () => {
    const res = await call("u2");
    expect(res.status).toBe(200);
    expect(findUnique.mock.calls[0][0].where).toEqual({ userId_tenantId: { userId: "u2", tenantId: "t1" } });
    expect(del).toHaveBeenCalledWith({ where: { userId_tenantId: { userId: "u2", tenantId: "t1" } } });
    expect(vi.mocked(recordAudit).mock.calls[0][0]).toMatchObject({ kind: "user.remove", target: "u2" });
  });

  it("refuses to remove yourself", async () => {
    expect((await call("u1")).status).toBe(400);
    expect(del).not.toHaveBeenCalled();
  });

  it("404s on someone who isn't a member here — another workspace's user included", async () => {
    findUnique.mockResolvedValueOnce(null);
    expect((await call("u9")).status).toBe(404);
    expect(del).not.toHaveBeenCalled();
  });

  it("leaves pending invites to the revoke-invite route", async () => {
    findUnique.mockResolvedValueOnce(member({ user: { id: "u2", email: "x@y.z", passwordHash: null } }));
    expect((await call("u2")).status).toBe(409);
    expect(del).not.toHaveBeenCalled();
  });

  it("never removes the workspace's last admin", async () => {
    findUnique.mockResolvedValueOnce(member({ role: "admin" }));
    count.mockResolvedValueOnce(1);
    expect((await call("u2")).status).toBe(409);
    expect(del).not.toHaveBeenCalled();
  });

  it("removes an admin when another admin remains", async () => {
    findUnique.mockResolvedValueOnce(member({ role: "admin" }));
    count.mockResolvedValueOnce(2);
    expect((await call("u2")).status).toBe(200);
  });

  it("hands the member's owner-only items to the removing admin, in this workspace only", async () => {
    const res = await call("u2");
    for (const m of ["dataSource", "dashboard", "onScreenDisplay", "lakeTable"] as const) {
      expect(updateMany[m]).toHaveBeenCalledWith({ where: { tenantId: "t1", ownerUserId: "u2" }, data: { ownerUserId: "u1" } });
    }
    const body = await res.json();
    expect(body).toMatchObject({ movedItems: 4, moved: { dataSources: 1, dashboards: 2, screens: 0, lakeTables: 1 } });
  });

  it("revokes every live API key the member minted here, MCP connector keys included", async () => {
    const res = await call("u2");
    const args = (updateMany.apiKey.mock.calls[0] as any[])[0];
    expect(args.where).toEqual({ tenantId: "t1", createdById: "u2", revokedAt: null });
    expect(args.data.revokedAt).toBeInstanceOf(Date);
    expect((await res.json()).revokedKeys).toBe(3);
    expect(vi.mocked(recordAudit).mock.calls[0][0].meta).toMatchObject({ revokedApiKeys: 3, movedToAdmin: { dashboards: 2 } });
  });

  it("changes nothing when the member can't be removed", async () => {
    findUnique.mockResolvedValueOnce(member({ role: "admin" }));
    count.mockResolvedValueOnce(1);
    await call("u2");
    expect(updateMany.apiKey).not.toHaveBeenCalled();
    expect(updateMany.dashboard).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireAdmin).mockResolvedValueOnce(NextResponse.json({ error: "Admin only" }, { status: 403 }) as any);
    expect((await call("u2")).status).toBe(403);
    expect(del).not.toHaveBeenCalled();
  });
});
