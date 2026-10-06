/**
 * SEC-1 (audit 2026-09-27): any admin can add an existing account's email to
 * their own workspace (the membership is created at once), and this route
 * then set the password on the GLOBAL account row — taking the account over
 * in every workspace it belongs to. The password may now be set only when
 * the account belongs to this workspace alone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const prisma = vi.hoisted(() => ({
  membership: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
  user: { update: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/dbContext", () => ({ withSystemDbContext: (fn: () => unknown) => fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(), MEMBERSHIP_ROLES: ["admin", "editor", "developer", "executive", "viewer"] }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/ee", () => ({ ee: {} }));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn(async () => "hashed") } }));

import { requireAdmin } from "@/lib/auth";
import { PATCH } from "./route";

const patch = (body: unknown) =>
  PATCH(new NextRequest("http://localhost:3100/api/admin/users/u-victim/role", { method: "PATCH", body: JSON.stringify(body) }), { params: { id: "u-victim" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({ id: "u-admin", tenantId: "t-mine", role: "admin" } as any);
  prisma.membership.findUnique.mockResolvedValue({ role: "viewer", user: { email: "victim@example.test" } });
  prisma.membership.update.mockResolvedValue({});
});

describe("PATCH /api/admin/users/[id]/role — resetPassword", () => {
  it("refuses to set the password of an account that also belongs to another workspace, and changes nothing", async () => {
    prisma.membership.count.mockResolvedValue(1);

    const res = await patch({ authRole: "viewer", resetPassword: "attacker-chosen-pw" });

    expect(res.status).toBe(403);
    expect(prisma.membership.count).toHaveBeenCalledWith({ where: { userId: "u-victim", tenantId: { not: "t-mine" } } });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.membership.update).not.toHaveBeenCalled();
  });

  it("still lets the admin set the password of an account that is only in this workspace", async () => {
    prisma.membership.count.mockResolvedValue(0);

    const res = await patch({ authRole: "editor", resetPassword: "new-password-1" });

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u-victim" }, data: { passwordHash: "hashed", passwordChangedAt: expect.any(Date) } });
  });

  it("changing only the role never looks at other workspaces", async () => {
    const res = await patch({ authRole: "editor" });

    expect(res.status).toBe(200);
    expect(prisma.membership.count).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
