/**
 * Row-level lease, generalized across any Prisma model that carries its
 * own `leasedBy`/`leasedUntil` columns.
 *
 * E2_JOBS_SCOPING_PLAN.md §3, Option A: `sync/leases.ts` proved this
 * pattern works in production for `SyncJob` — a conditional UPDATE that
 * flips `leasedBy`/`leasedUntil` atomically, so exactly one of several
 * concurrent cron ticks (replicas, a manual trigger racing the scheduled
 * one) wins the row, and a crashed worker's lease simply expires at
 * `leasedUntil` for the next tick to reclaim. Rather than adopt a new
 * job-queue dependency (pg-boss, the RFC's Option B) to get this for the
 * other six subsystems, this module lifts the SAME algorithm out to work
 * against any model, so `sync/leases.ts` becomes a thin binding onto
 * `SyncJob` instead of a second, parallel implementation.
 *
 * `LeaseDelegate` is the minimal slice of a Prisma model delegate this
 * needs — every generated delegate (`prisma.materializedView`,
 * `prisma.lakePipeline`, ...) satisfies it structurally, no explicit
 * adapter required.
 */

/** Default time-to-live for a freshly acquired lease. */
export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export type LeaseDelegate = {
  updateMany: (args: { where: any; data: any }) => Promise<{ count: number }>;
};

/**
 * Try to acquire a lease on `id` (row PK) for `workerId` for `ttlMs`.
 * Returns true if we got it, false if someone else holds it (and their
 * lease hasn't expired). Safe to call concurrently from multiple
 * processes — at most one wins.
 */
export async function acquireLeaseOn(
  delegate: LeaseDelegate,
  args: { id: string; workerId: string; ttlMs?: number },
): Promise<boolean> {
  const ttl = args.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = new Date();
  const until = new Date(now.getTime() + ttl);

  const res = await delegate.updateMany({
    where: {
      id: args.id,
      OR: [
        { leasedBy: null },
        { leasedUntil: null },
        { leasedUntil: { lt: now } },
      ],
    },
    data: {
      leasedBy: args.workerId,
      leasedUntil: until,
    },
  });
  return res.count === 1;
}

/**
 * Push the lease deadline out by `ttlMs`. Only succeeds if the caller
 * still owns the lease — a stale worker that woke up after its lease
 * expired and was claimed by someone else can't clobber the new owner.
 */
export async function heartbeatLeaseOn(
  delegate: LeaseDelegate,
  args: { id: string; workerId: string; ttlMs?: number },
): Promise<boolean> {
  const ttl = args.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const until = new Date(Date.now() + ttl);
  const res = await delegate.updateMany({
    where: { id: args.id, leasedBy: args.workerId },
    data: { leasedUntil: until },
  });
  return res.count === 1;
}

/**
 * Release the lease. Idempotent — releasing a lease you don't own
 * (already expired, claimed by another worker, or never held) is a
 * no-op, NOT an error, so cleanup code in a `finally` block stays dumb-
 * simple.
 */
export async function releaseLeaseOn(
  delegate: LeaseDelegate,
  args: { id: string; workerId: string },
): Promise<void> {
  await delegate.updateMany({
    where: { id: args.id, leasedBy: args.workerId },
    data: { leasedBy: null, leasedUntil: null },
  });
}

/**
 * Convenience: acquire → run → release. Returns null if the lease
 * couldn't be acquired. Always releases on exit, even if `fn` throws;
 * errors from `fn` propagate after release.
 */
export async function withLeaseOn<T>(
  delegate: LeaseDelegate,
  args: { id: string; workerId: string; ttlMs?: number },
  fn: () => Promise<T>,
): Promise<T | null> {
  const got = await acquireLeaseOn(delegate, args);
  if (!got) return null;
  try {
    return await fn();
  } finally {
    await releaseLeaseOn(delegate, args);
  }
}
