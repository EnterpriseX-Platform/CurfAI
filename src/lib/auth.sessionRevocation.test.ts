/**
 * OWASP A07:2025 regression — a deleted User row (the actual
 * incident-response action for "kill this compromised session now") must
 * stop an already-issued JWT session from working, not keep it valid for
 * the rest of the token's lifetime. NextAuth's jwt() callback can't force
 * a client-side sign-out directly, so the fix routes through session():
 * jwt() marks the token `deleted` when its periodic re-check finds no row,
 * and session() turns that into a session with no usable identity —
 * exactly what requireUser()'s `if (!u.tenantId) return null` treats as
 * "not signed in".
 *
 * Post User<->Workspace migration: role/tenant membership live on
 * Membership, not the User row, so the periodic re-check now distinguishes
 * two cases that used to be the same lookup — the account itself is gone
 * (sign out fully) vs. just this ONE workspace's Membership was removed
 * (fall back to another membership, or sign out only if none are left).
 *
 * 2026-08 role restructure adds a THIRD case the same "no Membership row"
 * signal must NOT be confused with: a Platform Admin viewing a tenant they
 * hold only via OrgMembership oversight (no real Membership by design —
 * see loadMembershipsForUserId() in ./auth.ts). That case must refresh
 * role in place and NOT fall back, or every Platform Admin viewing an
 * org-derived tenant gets silently bounced every 5 minutes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const membershipFindUniqueMock = vi.fn();
const userFindUniqueMock = vi.fn();
const membershipFindManyMock = vi.fn();
const tenantFindUniqueMock = vi.fn();
const orgMembershipFindUniqueMock = vi.fn();
const orgMembershipFindManyMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => userFindUniqueMock(...args) },
    membership: {
      findUnique: (...args: unknown[]) => membershipFindUniqueMock(...args),
      findMany: (...args: unknown[]) => membershipFindManyMock(...args),
    },
    tenant: { upsert: vi.fn(), findUnique: (...args: unknown[]) => tenantFindUniqueMock(...args) },
    orgMembership: {
      findUnique: (...args: unknown[]) => orgMembershipFindUniqueMock(...args),
      findMany: (...args: unknown[]) => orgMembershipFindManyMock(...args),
    },
  },
}));

const { authOptions } = await import("./auth");
const jwtCallback = authOptions.callbacks!.jwt!;
const sessionCallback = authOptions.callbacks!.session!;

const STALE = Date.now() - 10 * 60_000; // older than ROLE_CHECK_INTERVAL_MS (5 min)

beforeEach(() => {
  membershipFindUniqueMock.mockReset();
  userFindUniqueMock.mockReset();
  membershipFindManyMock.mockReset();
  tenantFindUniqueMock.mockReset();
  orgMembershipFindUniqueMock.mockReset();
  orgMembershipFindManyMock.mockReset();
  // Default: not covered by any org grant, and loadMembershipsForUserId's
  // own OrgMembership lookup finds nothing extra to union in. Individual
  // tests override these where the scenario needs org coverage.
  tenantFindUniqueMock.mockResolvedValue({ organizationId: null });
  orgMembershipFindUniqueMock.mockResolvedValue(null);
  orgMembershipFindManyMock.mockResolvedValue([]);
  // session() now resolves memberships fresh via loadMembershipsForUserId()
  // on every call (no longer cached on the token — see auth.ts), so any
  // test exercising session() needs this mocked even when it isn't the
  // thing under test.
  membershipFindManyMock.mockResolvedValue([]);
});

describe("jwt() periodic re-check", () => {
  it("marks the token deleted when the account itself no longer exists", async () => {
    membershipFindUniqueMock.mockResolvedValueOnce(null);
    userFindUniqueMock.mockResolvedValueOnce(null); // no User row at all
    const token: any = { id: "u1", email: "u1@test.com", tenantId: "t1", role: "admin", roleCheckedAt: STALE };
    const result: any = await jwtCallback({ token } as any);
    expect(result.deleted).toBe(true);
  });

  it("does NOT mark deleted when the membership still exists — just refreshes role", async () => {
    membershipFindUniqueMock.mockResolvedValueOnce({ role: "editor" });
    const token: any = { id: "u1", email: "u1@test.com", tenantId: "t1", role: "admin", roleCheckedAt: STALE };
    const result: any = await jwtCallback({ token } as any);
    expect(result.deleted).toBeUndefined();
    expect(result.role).toBe("editor");
  });

  it("falls back to another workspace when only THIS membership was removed", async () => {
    membershipFindUniqueMock.mockResolvedValueOnce(null); // t1 membership gone
    userFindUniqueMock.mockResolvedValueOnce({ id: "u1" }); // but the account still exists
    membershipFindManyMock.mockResolvedValueOnce([
      { tenantId: "t2", tenant: { slug: "t2-slug", name: "T2" }, role: "viewer" },
    ]);
    const token: any = { id: "u1", email: "u1@test.com", tenantId: "t1", activeTenantId: "t1", role: "admin", roleCheckedAt: STALE };
    const result: any = await jwtCallback({ token } as any);
    expect(result.deleted).toBeUndefined();
    expect(result.tenantId).toBe("t2");
    expect(result.activeTenantId).toBe("t2");
    expect(result.role).toBe("viewer");
  });

  it("stays on the tenant and just refreshes role when covered by Platform Admin org oversight (no real Membership by design)", async () => {
    membershipFindUniqueMock.mockResolvedValueOnce(null); // no real Membership for t1 — expected for virtual access
    userFindUniqueMock.mockResolvedValueOnce({ id: "u1" });
    tenantFindUniqueMock.mockResolvedValueOnce({ organizationId: "org1" });
    orgMembershipFindUniqueMock.mockResolvedValueOnce({ role: "platform_admin" });
    const token: any = { id: "u1", email: "u1@test.com", tenantId: "t1", activeTenantId: "t1", role: "admin", roleCheckedAt: STALE };
    const result: any = await jwtCallback({ token } as any);
    expect(result.deleted).toBeUndefined();
    expect(result.tenantId).toBe("t1"); // unchanged — no fallback
    expect(result.activeTenantId).toBe("t1");
    expect(result.role).toBe("admin");
    // The expensive fallback (loadMembershipsForUserId -> membership.findMany) must not run.
    expect(membershipFindManyMock).not.toHaveBeenCalled();
  });

  it("falls back normally when the tenant has an org but the OrgMembership role isn't platform_admin", async () => {
    membershipFindUniqueMock.mockResolvedValueOnce(null);
    userFindUniqueMock.mockResolvedValueOnce({ id: "u1" });
    tenantFindUniqueMock.mockResolvedValueOnce({ organizationId: "org1" });
    orgMembershipFindUniqueMock.mockResolvedValueOnce(null); // no grant at all for this org
    membershipFindManyMock.mockResolvedValueOnce([
      { tenantId: "t2", tenant: { slug: "t2-slug", name: "T2" }, role: "viewer" },
    ]);
    const token: any = { id: "u1", email: "u1@test.com", tenantId: "t1", activeTenantId: "t1", role: "admin", roleCheckedAt: STALE };
    const result: any = await jwtCallback({ token } as any);
    expect(result.tenantId).toBe("t2");
  });

  it("signs out fully when the removed membership was the user's last one", async () => {
    membershipFindUniqueMock.mockResolvedValueOnce(null);
    userFindUniqueMock.mockResolvedValueOnce({ id: "u1" });
    membershipFindManyMock.mockResolvedValueOnce([]); // no memberships left anywhere
    const token: any = { id: "u1", email: "u1@test.com", tenantId: "t1", role: "admin", roleCheckedAt: STALE };
    const result: any = await jwtCallback({ token } as any);
    expect(result.deleted).toBe(true);
  });

  it("skips the DB call entirely when the last check was recent", async () => {
    const token: any = { id: "u1", email: "u1@test.com", tenantId: "t1", role: "admin", roleCheckedAt: Date.now() };
    await jwtCallback({ token } as any);
    expect(membershipFindUniqueMock).not.toHaveBeenCalled();
  });
});

describe("jwt() periodic re-check — a failed lookup is not an answer", () => {
  // Each lookup used to .catch(() => null), so a transient DB error read
  // as "no row": the user was silently moved into another workspace, or —
  // if the account check failed too — signed out. Neither should happen.
  const fresh = () => ({ id: "u1", email: "u1@test.com", tenantId: "t1", activeTenantId: "t1", role: "admin", roleCheckedAt: STALE });

  it("keeps the workspace when the membership lookup itself fails", async () => {
    membershipFindUniqueMock.mockRejectedValueOnce(new Error("connection reset"));
    const result: any = await jwtCallback({ token: fresh() } as any);
    expect(result.tenantId).toBe("t1");
    expect(result.activeTenantId).toBe("t1");
    expect(result.deleted).toBeUndefined();
    expect(membershipFindManyMock).not.toHaveBeenCalled();
  });

  it("doesn't sign the user out when the account lookup fails", async () => {
    membershipFindUniqueMock.mockResolvedValueOnce(null);
    userFindUniqueMock.mockRejectedValueOnce(new Error("timeout"));
    const result: any = await jwtCallback({ token: fresh() } as any);
    expect(result.deleted).toBeUndefined();
    expect(result.tenantId).toBe("t1");
  });

  it("doesn't fall back when the org-oversight lookup fails", async () => {
    membershipFindUniqueMock.mockResolvedValueOnce(null);
    userFindUniqueMock.mockResolvedValueOnce({ id: "u1" });
    tenantFindUniqueMock.mockRejectedValueOnce(new Error("timeout"));
    const result: any = await jwtCallback({ token: fresh() } as any);
    expect(result.tenantId).toBe("t1");
    expect(membershipFindManyMock).not.toHaveBeenCalled();
  });

  it("retries on the next request instead of waiting out the interval", async () => {
    membershipFindUniqueMock.mockRejectedValueOnce(new Error("connection reset"));
    const result: any = await jwtCallback({ token: fresh() } as any);
    expect(result.roleCheckedAt).toBe(STALE);
  });
});

describe("jwt() — a password reset signs out older sessions (audit 2026-09-27, SEC-13)", () => {
  const token = (authAt: number) => ({ id: "u1", tenantId: "t1", role: "admin", roleCheckedAt: STALE, authAt });

  it("marks a session authenticated before the last password change as deleted", async () => {
    membershipFindUniqueMock.mockResolvedValue({ role: "admin" });
    userFindUniqueMock.mockResolvedValue({ passwordChangedAt: new Date(Date.now() - 60_000) });
    const result: any = await jwtCallback({ token: token(Date.now() - 3_600_000) } as any);
    expect(result.deleted).toBe(true);
  });

  it("keeps a session that authenticated after the change", async () => {
    membershipFindUniqueMock.mockResolvedValue({ role: "admin" });
    userFindUniqueMock.mockResolvedValue({ passwordChangedAt: new Date(Date.now() - 3_600_000) });
    const result: any = await jwtCallback({ token: token(Date.now() - 60_000) } as any);
    expect(result.deleted).toBeUndefined();
  });

  it("stamps authAt when the session is first issued", async () => {
    const result: any = await jwtCallback({ token: {}, user: { id: "u1", role: "admin", tenantId: "t1" } } as any);
    expect(typeof result.authAt).toBe("number");
  });
});

describe("session() honoring a deleted token", () => {
  it("strips tenantId/id so requireUser() treats this as unauthenticated", async () => {
    const session: any = { user: {} };
    const token: any = { id: "u1", tenantId: "t1", role: "admin", deleted: true };
    const result: any = await sessionCallback({ session, token } as any);
    expect(result.user.tenantId).toBeUndefined();
    expect(result.user.id).toBeUndefined();
  });

  it("passes identity through normally when the token isn't marked deleted", async () => {
    const session: any = { user: {} };
    const token: any = { id: "u1", tenantId: "t1", role: "admin" };
    const result: any = await sessionCallback({ session, token } as any);
    expect(result.user.tenantId).toBe("t1");
    expect(result.user.id).toBe("u1");
    expect(result.user.role).toBe("admin");
  });
});
