/**
 * A suspended workspace (lib/platform/tenants.ts) is closed at every way in: password sign-in, a session that is already
 * open, and API keys. Nothing is deleted — restoring it reopens everything.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const prisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  membership: { findMany: vi.fn() },
  orgMembership: { findMany: vi.fn(async () => []) },
  tenant: { findMany: vi.fn(async () => []) },
  apiKey: { findFirst: vi.fn(), update: vi.fn(() => Promise.resolve({})) },
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/dbContext", () => ({ bindRequestDbContext: vi.fn(), withSystemDbContext: (fn: () => unknown) => fn() }));
const compare = vi.hoisted(() => vi.fn());
vi.mock("bcryptjs", () => ({ default: { compare, hash: vi.fn() } }));
const recordAudit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit", () => ({ recordAudit }));

const { authOptions, requireUser, WORKSPACE_SUSPENDED } = await import("./auth");
const authorize = (authOptions.providers.find((p: any) => p.id === "credentials") as any).options.authorize as
  (c: { email: string; password: string }) => Promise<any>;
const sessionCb = authOptions.callbacks!.session!;

let n = 0;
const m = (tenantId: string, status: string, role = "admin") => ({ tenantId, role, tenant: { status } });
const login = (memberships: unknown[]) => {
  const email = `person${++n}@example.test`; // the sign-in limiter counts per address
  prisma.user.findUnique.mockResolvedValue({ id: "u1", email, name: null, passwordHash: "$2a$x", emailVerifiedAt: new Date(), emailVerifyGrandfathered: false });
  prisma.membership.findMany.mockResolvedValue(memberships);
  return authorize({ email, password: "right" });
};

beforeEach(() => {
  vi.clearAllMocks();
  compare.mockResolvedValue(true);
  prisma.orgMembership.findMany.mockResolvedValue([]);
  prisma.tenant.findMany.mockResolvedValue([]);
});

describe("password sign-in", () => {
  it("lands in the oldest workspace that is still open", async () => {
    expect(await login([m("t-closed", "suspended"), m("t-open", "active", "viewer")])).toMatchObject({ tenantId: "t-open", role: "viewer" });
  });

  it("with every workspace suspended, says so after the password and records why", async () => {
    await expect(login([m("t1", "suspended"), m("t2", "suspended")])).rejects.toThrow(WORKSPACE_SUSPENDED);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", kind: "signin.failed", meta: { reason: "workspace_suspended" } }));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t2", kind: "signin.failed" }));
  });

  it("a wrong password still looks like any wrong password — it must not reveal the workspace is suspended", async () => {
    compare.mockResolvedValueOnce(false);
    expect(await login([m("t1", "suspended")])).toBeNull();
  });

  it("an account in no workspace is still just refused", async () => {
    expect(await login([])).toBeNull();
  });

  it("the error text the login pages match on is stable", () => {
    expect(WORKSPACE_SUSPENDED).toBe("Workspace suspended");
  });
});

describe("a session that is already open", () => {
  const token = (tenantId: string, role = "admin") => ({ id: "u1", tenantId, activeTenantId: tenantId, role, email: "a@x.test" });
  const run = (tok: any) => sessionCb({ session: { user: {} }, token: tok } as any) as Promise<any>;
  const rows = (...r: Array<{ tenantId: string; status: string; role?: string }>) =>
    prisma.membership.findMany.mockResolvedValue(r.map((x) => ({
      tenantId: x.tenantId, role: x.role ?? "admin", tenant: { id: x.tenantId, slug: x.tenantId, name: x.tenantId, tier: "growth", status: x.status },
    })));

  it("is untouched while its workspace is open", async () => {
    rows({ tenantId: "t1", status: "active" });
    const s = await run(token("t1"));
    expect(s.user).toMatchObject({ id: "u1", tenantId: "t1", role: "admin" });
  });

  it("moves to a workspace that is still open the moment its own is suspended — not at the next 5-minute check", async () => {
    rows({ tenantId: "t1", status: "suspended" }, { tenantId: "t2", status: "active", role: "viewer" });
    const s = await run(token("t1"));
    expect(s.user).toMatchObject({ id: "u1", tenantId: "t2", role: "viewer", activeTenantId: "t2" });
  });

  it("carries no identity when there is no open workspace — requireUser() reads that as 'not signed in'", async () => {
    rows({ tenantId: "t1", status: "suspended" });
    const s = await run(token("t1"));
    expect(s.user.id).toBeUndefined();
    expect(s.user.tenantId).toBeUndefined();
  });

  it("the membership list tells the switcher which workspaces are suspended", async () => {
    rows({ tenantId: "t1", status: "active" }, { tenantId: "t2", status: "suspended" });
    const s = await run(token("t1"));
    expect(s.user.memberships.map((x: any) => [x.tenantId, x.tenantStatus])).toEqual([["t1", "active"], ["t2", "suspended"]]);
  });
});

describe("API keys", () => {
  const call = () => requireUser(new NextRequest("http://localhost:3100/api/v1/reports", { headers: { authorization: "Bearer curf_0123456789abcdefghij" } }));
  const key = (status: string) => ({
    id: "k1", prefix: "curf_0123456", hashedSecret: "$2a$h", role: "admin", tenantId: "t1", name: "ci",
    scopedReportIds: null, tenant: { status },
  });

  it("works for an open workspace", async () => {
    prisma.apiKey.findFirst.mockResolvedValue(key("active"));
    compare.mockResolvedValue(true);
    expect(await call()).toMatchObject({ tenantId: "t1", viaApiKey: true });
  });

  it("is refused once the workspace is suspended, even with the right secret", async () => {
    prisma.apiKey.findFirst.mockResolvedValue(key("suspended"));
    compare.mockResolvedValue(true);
    expect(await call()).toBeNull();
  });

  it("reads the workspace's status in the same query as the key — no extra lookup per API request", async () => {
    prisma.apiKey.findFirst.mockResolvedValue(key("active"));
    compare.mockResolvedValue(true);
    await call();
    expect(prisma.apiKey.findFirst.mock.calls[0]![0].include).toEqual({ tenant: { select: { status: true } } });
  });
});
