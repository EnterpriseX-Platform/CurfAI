/**
 * Regression coverage for tickLakePulls/tickMaterializedViews' E2 Phase C
 * lease + JobRun wiring (E2_JOBS_SCOPING_PLAN.md §5): both now acquire the
 * same conditional-UPDATE lease sync/leases.ts already proves works before
 * running, so two racing cron ticks (replicas, a manual trigger) can't both
 * fire the same LakePull/MaterializedView concurrently, and both write a
 * JobRun row the way dispatchDueSyncs (the reference implementation) does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const PULL = { id: "pull1", tenantId: "t-lake-jobrun", name: "Daily Stripe", cron: "* * * * *", tableName: "charges" };
const MV = { id: "mv1", tenantId: "t-lake-jobrun", name: "MRR overview", cron: "* * * * *" };

const state = vi.hoisted(() => ({
  jobRunRows: new Map<string, any>(),
  nextId: 1,
  leaseAcquired: true,
  released: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    lakePull: { findMany: vi.fn(async () => [PULL]) },
    materializedView: { findMany: vi.fn(async () => [MV]) },
    jobRun: {
      create: vi.fn(async ({ data }: any) => {
        const id = `jr${state.nextId++}`;
        const row = { id, ...data };
        state.jobRunRows.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        Object.assign(state.jobRunRows.get(where.id), data);
      }),
    },
  },
}));

vi.mock("./leases", () => ({
  acquireLeaseOn: vi.fn(async () => state.leaseAcquired),
  releaseLeaseOn: vi.fn(async (delegate: any, args: any) => { state.released.push(args.id); }),
}));

const runLakePull = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lake/restPull", () => ({ runLakePull }));
const refreshMaterializedView = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lake/materialize", () => ({ refreshMaterializedView }));

import { tickLakePulls, tickMaterializedViews } from "./lakeTicks";

beforeEach(() => {
  state.jobRunRows.clear();
  state.released = [];
  state.leaseAcquired = true;
  runLakePull.mockReset();
  refreshMaterializedView.mockReset();
});

describe("tickLakePulls — lease + JobRun", () => {
  it("acquires the lease, creates a running JobRun, finalizes to ok, and releases", async () => {
    runLakePull.mockResolvedValue({ status: "ok", rowsWritten: 42 });
    const fired: any[] = [];
    await tickLakePulls(fired, new Date(), true);

    expect(runLakePull).toHaveBeenCalledWith("pull1");
    expect(state.jobRunRows.size).toBe(1);
    const row = [...state.jobRunRows.values()][0];
    expect(row).toMatchObject({
      tenantId: "t-lake-jobrun", kind: "restPull", targetId: "pull1", targetLabel: "Daily Stripe",
      status: "ok", rowsAffected: 42,
    });
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(state.released).toEqual(["pull1"]);
  });

  it("skips the pull entirely (no run, no JobRun) when another worker holds the lease", async () => {
    state.leaseAcquired = false;
    const fired: any[] = [];
    await tickLakePulls(fired, new Date(), true);

    expect(runLakePull).not.toHaveBeenCalled();
    expect(state.jobRunRows.size).toBe(0);
    expect(fired).toEqual([]);
  });

  it("still releases the lease, and finalizes JobRun to failed, when the pull throws", async () => {
    runLakePull.mockRejectedValue(new Error("upstream 500"));
    const fired: any[] = [];
    await tickLakePulls(fired, new Date(), true);

    const row = [...state.jobRunRows.values()][0];
    expect(row.status).toBe("failed");
    expect(row.error).toContain("upstream 500");
    expect(state.released).toEqual(["pull1"]);
    expect(fired[0]).toMatchObject({ id: "pull1", status: "failed" });
  });
});

describe("tickMaterializedViews — lease + JobRun", () => {
  it("acquires the lease, creates a running JobRun, finalizes to ok, and releases", async () => {
    refreshMaterializedView.mockResolvedValue({ status: "ok", rowCount: 7, durationMs: 12 });
    const fired: any[] = [];
    await tickMaterializedViews(fired, new Date(), true);

    expect(refreshMaterializedView).toHaveBeenCalledWith("mv1");
    const row = [...state.jobRunRows.values()][0];
    expect(row).toMatchObject({
      tenantId: "t-lake-jobrun", kind: "materialize", targetId: "mv1", targetLabel: "MRR overview",
      status: "ok", rowsAffected: 7,
    });
    expect(state.released).toEqual(["mv1"]);
  });

  it("skips the refresh when another worker holds the lease", async () => {
    state.leaseAcquired = false;
    const fired: any[] = [];
    await tickMaterializedViews(fired, new Date(), true);

    expect(refreshMaterializedView).not.toHaveBeenCalled();
    expect(state.jobRunRows.size).toBe(0);
  });
});
