/**
 * The guard for entry points that have a workspace id but no signed-in member.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const prisma = vi.hoisted(() => ({ tenant: { findUnique: vi.fn(), findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/dbContext", () => ({ withSystemDbContext: (fn: () => unknown) => fn() }));

import { tenantIsOpen, closedTenantIds, forgetTenantStatus, TTL_MS } from "./tenantGuard";
import { tenantOpen, closedReason, OPEN_TENANT } from "./tenantStatus";

beforeEach(() => { vi.clearAllMocks(); forgetTenantStatus(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("tenantStatus", () => {
  it("only 'active' (or a row from before the column) is open", () => {
    expect(tenantOpen("active")).toBe(true);
    expect(tenantOpen(null)).toBe(true);
    expect(tenantOpen(undefined)).toBe(true);
    expect(tenantOpen("suspended")).toBe(false);
    expect(tenantOpen("pending_deletion")).toBe(false);
    expect(tenantOpen("something-new")).toBe(false); // a status nobody taught this to is closed, not open
  });
  it("says why a workspace is closed", () => {
    expect(closedReason("active")).toBeNull();
    expect(closedReason("pending_deletion")).toBe("pending_deletion");
    expect(closedReason("suspended")).toBe("suspended");
    expect(OPEN_TENANT).toEqual({ status: "active" });
  });
});

describe("tenantIsOpen", () => {
  it("is true for an active workspace, false for a closed one, false for one that doesn't exist", async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ status: "active" });
    expect(await tenantIsOpen("a")).toBe(true);
    prisma.tenant.findUnique.mockResolvedValueOnce({ status: "suspended" });
    expect(await tenantIsOpen("b")).toBe(false);
    prisma.tenant.findUnique.mockResolvedValueOnce({ status: "pending_deletion" });
    expect(await tenantIsOpen("c")).toBe(false);
    prisma.tenant.findUnique.mockResolvedValueOnce(null);
    expect(await tenantIsOpen("gone")).toBe(false);
  });

  it("has no workspace for a missing id, so it is not open", async () => {
    expect(await tenantIsOpen(null)).toBe(false);
    expect(await tenantIsOpen(undefined)).toBe(false);
    expect(await tenantIsOpen("")).toBe(false);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("remembers an answer for a few seconds, then asks again", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ status: "active" });
    await tenantIsOpen("a"); await tenantIsOpen("a"); await tenantIsOpen("a");
    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TTL_MS + 1);
    await tenantIsOpen("a");
    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(2);
  });

  it("a change made in this process is seen at once, not after the cache runs out", async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ status: "active" });
    expect(await tenantIsOpen("a")).toBe(true);
    forgetTenantStatus("a");
    prisma.tenant.findUnique.mockResolvedValueOnce({ status: "suspended" });
    expect(await tenantIsOpen("a")).toBe(false);
  });

  it("does not answer 'open' because the lookup failed", async () => {
    prisma.tenant.findUnique.mockRejectedValueOnce(new Error("db down"));
    await expect(tenantIsOpen("a")).rejects.toThrow("db down");
  });
});

describe("closedTenantIds", () => {
  it("lists the workspaces that are not active, for a job to leave out", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([{ id: "s1" }, { id: "p1" }]);
    expect(await closedTenantIds()).toEqual(["s1", "p1"]);
    expect(prisma.tenant.findMany.mock.calls[0]![0].where).toEqual({ status: { not: "active" } });
  });

  it("is cached briefly and refreshed by forgetTenantStatus", async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: "s1" }]);
    await closedTenantIds(); await closedTenantIds();
    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(1);
    forgetTenantStatus();
    await closedTenantIds();
    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(2);
  });

  it("is empty when nothing is closed", async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([]);
    expect(await closedTenantIds()).toEqual([]);
  });
});
