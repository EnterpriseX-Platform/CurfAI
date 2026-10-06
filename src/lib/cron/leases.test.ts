/**
 * The generalized lease (E2_JOBS_SCOPING_PLAN.md §3 Option A) against a
 * fake delegate — sync/leases.ts's own indirect coverage (scheduler.test.ts)
 * already proves the algorithm against a real prisma.syncJob; this pins the
 * generic `*On()` functions directly, including the two-worker race that's
 * the entire point of the lease.
 */
import { describe, it, expect } from "vitest";
import { acquireLeaseOn, heartbeatLeaseOn, releaseLeaseOn, withLeaseOn, DEFAULT_LEASE_TTL_MS } from "./leases";

type LeaseRow = { leasedBy: string | null; leasedUntil: Date | null };

/** A tiny in-memory stand-in for a Prisma delegate's updateMany(). */
function fakeDelegate(rows: Map<string, LeaseRow>) {
  return {
    updateMany: async ({ where, data }: any) => {
      const row = rows.get(where.id);
      if (!row) return { count: 0 };
      if (where.OR) {
        const now = new Date();
        const eligible = row.leasedBy == null || row.leasedUntil == null || row.leasedUntil < now;
        if (!eligible) return { count: 0 };
      } else if (where.leasedBy != null && row.leasedBy !== where.leasedBy) {
        return { count: 0 };
      }
      Object.assign(row, data);
      return { count: 1 };
    },
  };
}

describe("acquireLeaseOn / releaseLeaseOn", () => {
  it("grants the lease to the first caller and refuses a second concurrent one", async () => {
    const rows = new Map<string, LeaseRow>([["r1", { leasedBy: null, leasedUntil: null }]]);
    const delegate = fakeDelegate(rows);

    expect(await acquireLeaseOn(delegate, { id: "r1", workerId: "a" })).toBe(true);
    expect(await acquireLeaseOn(delegate, { id: "r1", workerId: "b" })).toBe(false);
    expect(rows.get("r1")!.leasedBy).toBe("a");
  });

  it("reclaims an expired lease for a new worker", async () => {
    const rows = new Map<string, LeaseRow>([["r1", { leasedBy: "a", leasedUntil: new Date(Date.now() - 1000) }]]);
    const delegate = fakeDelegate(rows);

    expect(await acquireLeaseOn(delegate, { id: "r1", workerId: "b" })).toBe(true);
    expect(rows.get("r1")!.leasedBy).toBe("b");
  });

  it("releasing a lease you don't own is a no-op, not an error", async () => {
    const rows = new Map<string, LeaseRow>([["r1", { leasedBy: "a", leasedUntil: new Date(Date.now() + 60_000) }]]);
    const delegate = fakeDelegate(rows);

    await releaseLeaseOn(delegate, { id: "r1", workerId: "b" });
    expect(rows.get("r1")).toEqual({ leasedBy: "a", leasedUntil: expect.any(Date) });
  });

  it("releasing your own lease clears it, freeing the row for the next caller", async () => {
    const rows = new Map<string, LeaseRow>([["r1", { leasedBy: "a", leasedUntil: new Date(Date.now() + 60_000) }]]);
    const delegate = fakeDelegate(rows);

    await releaseLeaseOn(delegate, { id: "r1", workerId: "a" });
    expect(rows.get("r1")).toEqual({ leasedBy: null, leasedUntil: null });
    expect(await acquireLeaseOn(delegate, { id: "r1", workerId: "b" })).toBe(true);
  });

  it("defaults to a 5-minute TTL when none is given", async () => {
    const rows = new Map<string, LeaseRow>([["r1", { leasedBy: null, leasedUntil: null }]]);
    const delegate = fakeDelegate(rows);
    const before = Date.now();

    await acquireLeaseOn(delegate, { id: "r1", workerId: "a" });
    const until = rows.get("r1")!.leasedUntil!.getTime();
    expect(until).toBeGreaterThanOrEqual(before + DEFAULT_LEASE_TTL_MS - 50);
    expect(until).toBeLessThanOrEqual(before + DEFAULT_LEASE_TTL_MS + 5000);
  });
});

describe("heartbeatLeaseOn", () => {
  it("pushes the deadline out only for the current owner", async () => {
    const rows = new Map<string, LeaseRow>([["r1", { leasedBy: "a", leasedUntil: new Date(Date.now() + 1000) }]]);
    const delegate = fakeDelegate(rows);

    expect(await heartbeatLeaseOn(delegate, { id: "r1", workerId: "b" })).toBe(false);
    expect(await heartbeatLeaseOn(delegate, { id: "r1", workerId: "a", ttlMs: 120_000 })).toBe(true);
    expect(rows.get("r1")!.leasedUntil!.getTime()).toBeGreaterThan(Date.now() + 100_000);
  });
});

describe("withLeaseOn", () => {
  it("runs fn and releases the lease on success", async () => {
    const rows = new Map<string, LeaseRow>([["r1", { leasedBy: null, leasedUntil: null }]]);
    const delegate = fakeDelegate(rows);

    const result = await withLeaseOn(delegate, { id: "r1", workerId: "a" }, async () => "done");
    expect(result).toBe("done");
    expect(rows.get("r1")).toEqual({ leasedBy: null, leasedUntil: null });
  });

  it("returns null without calling fn when the lease can't be acquired", async () => {
    const rows = new Map<string, LeaseRow>([["r1", { leasedBy: "other", leasedUntil: new Date(Date.now() + 60_000) }]]);
    const delegate = fakeDelegate(rows);
    let called = false;

    const result = await withLeaseOn(delegate, { id: "r1", workerId: "a" }, async () => { called = true; return "x"; });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it("still releases the lease when fn throws, and the error propagates", async () => {
    const rows = new Map<string, LeaseRow>([["r1", { leasedBy: null, leasedUntil: null }]]);
    const delegate = fakeDelegate(rows);

    await expect(withLeaseOn(delegate, { id: "r1", workerId: "a" }, async () => { throw new Error("boom"); }))
      .rejects.toThrow("boom");
    expect(rows.get("r1")).toEqual({ leasedBy: null, leasedUntil: null });
  });
});
