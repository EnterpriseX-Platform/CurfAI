/**
 * SEC-18 (audit 2026-09-27): a reset link was checked, then marked used
 * afterwards, so two requests racing with the same link both set a password.
 * The token is now claimed atomically first.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const prisma = vi.hoisted(() => ({
  passwordResetToken: { findUnique: vi.fn(), updateMany: vi.fn() },
  user: { update: vi.fn() },
  membership: { findMany: vi.fn(async () => []) },
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(), persistAudit: vi.fn() }));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn(async () => "hashed") } }));

import { POST } from "./route";

const reset = () => POST(new NextRequest("http://localhost:3100/api/reset", {
  method: "POST", body: JSON.stringify({ token: "t".repeat(40), password: "a-new-password-1" }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  prisma.passwordResetToken.findUnique.mockResolvedValue({ id: "prt1", userId: "u1", usedAt: null, expiresAt: new Date(Date.now() + 60_000) });
  prisma.user.update.mockResolvedValue({ id: "u1", email: "u1@example.test" });
});

describe("POST /api/reset — one password per link", () => {
  it("sets the password when this request claims the link", async () => {
    prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    const res = await reset();
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({ where: { id: "prt1", usedAt: null }, data: { usedAt: expect.any(Date) } });
    expect(prisma.user.update).toHaveBeenCalled();
    expect(res.status).toBeLessThan(300);
  });

  it("refuses without touching the password when a concurrent request claimed it first", async () => {
    prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
    const res = await reset();
    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
