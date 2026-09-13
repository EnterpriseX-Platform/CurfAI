/**
 * Postgres Row-Level Security helpers.
 *
 * Curf's auth layer enforces tenant isolation in the application via
 * `tenantWhere(user)` on every query. That works, but a single missed
 * call leaks data across tenants. Postgres RLS turns this into a
 * defense-in-depth: even if the app forgets, the database refuses to
 * return rows from the wrong tenant.
 *
 * How it works:
 *   1. Every connection that serves a user request opens a transaction.
 *   2. We `SET LOCAL app.user_tenant_id = '<id>'`, scoped to the txn.
 *   3. The RLS policies in prisma/rls/policies.sql read that GUC and
 *      filter every SELECT/UPDATE/DELETE by `tenantId = current_setting(...)`.
 *   4. The transaction commits. The next request opens a new transaction
 *      with its own GUC values. There is no cross-request bleed.
 *
 * This file is the helper you wrap around every request that touches
 * tenant-scoped data. The current SQLite build is a no-op fallback —
 * `withTenantContext` just calls the callback. When the Postgres
 * migration ships, this is the only place the GUC SET happens; nothing
 * else in the codebase changes.
 *
 * Usage in an API route (post-cutover):
 *   const user = await requireUser(req);
 *   if (!user) return 401;
 *   const reports = await withTenantContext(user, (tx) =>
 *     tx.report.findMany()  // RLS auto-filters by tenant
 *   );
 *
 * Super-admin bypass: when `user.role === 'super_admin'` we set
 * `app.user_role = 'super_admin'` and the policies skip the tenant
 * check. Used by ops tooling and the cron sweeper.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CurfSessionUser } from "@/lib/auth";

/** Set true when the underlying datasource is Postgres. Read once at boot. */
const RLS_ENABLED = (() => {
  const url = process.env.DATABASE_URL ?? "";
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
})();

export type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

/**
 * Run `fn` with the caller's tenant + role exposed to Postgres as session
 * GUCs. RLS policies pick those up and auto-filter every query inside the
 * callback.
 *
 * On SQLite (RLS_ENABLED = false), this is a thin pass-through — the
 * application-layer `tenantWhere(user)` is still the active enforcement.
 * `isolationLevel`/`maxRetries` are Postgres-only and have no effect here
 * (SQLite has no equivalent, same caveat the rest of this file already
 * documents for RLS itself).
 *
 * Idempotent: nesting `withTenantContext` calls is safe; the inner call
 * sees the outer transaction. Pass `{ allowEscalation: true }` to permit
 * an inner call to elevate to super_admin (used by the cron sweeper).
 *
 * `isolationLevel: "Serializable"` + `maxRetries > 1` is for a callback
 * that does a check-then-write a caller needs atomic against concurrent
 * requests (see lib/billing.ts's quota helpers + QuotaBlockedError) —
 * Postgres aborts the losing side of a write conflict with error code
 * P2034 instead of letting both commit, and we retry a bounded number of
 * times rather than surfacing that as a hard failure.
 */
export async function withTenantContext<T>(
  user: CurfSessionUser,
  fn: (tx: Tx) => Promise<T>,
  opts?: { isolationLevel?: Prisma.TransactionIsolationLevel; maxRetries?: number },
): Promise<T> {
  if (!RLS_ENABLED) {
    // SQLite path: run the callback against the shared client. The
    // app-layer tenant filter still applies via tenantWhere(user).
    return fn(prisma as unknown as Tx);
  }
  const maxRetries = Math.max(1, opts?.maxRetries ?? 1);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // SET LOCAL is scoped to the current transaction and is
          // automatically reset at COMMIT/ROLLBACK. No leakage to the next
          // checkout from the pool, even when the connection is reused.
          await tx.$executeRaw(
            Prisma.sql`SELECT set_config('app.user_tenant_id', ${user.tenantId}, true)`,
          );
          await tx.$executeRaw(
            Prisma.sql`SELECT set_config('app.user_id',        ${user.id},       true)`,
          );
          await tx.$executeRaw(
            Prisma.sql`SELECT set_config('app.user_role',      ${user.role},     true)`,
          );
          return fn(tx as unknown as Tx);
        },
        opts?.isolationLevel ? { isolationLevel: opts.isolationLevel } : undefined,
      );
    } catch (e: any) {
      if (e?.code === "P2034" && attempt < maxRetries) continue;
      throw e;
    }
  }
  // Unreachable — the loop above always returns or throws — but keeps TS happy.
  throw new Error("withTenantContext: exhausted retries without resolving");
}

/**
 * Escape hatch for ops tooling that legitimately needs cross-tenant
 * reads (the cron sweeper that fires schedules for every tenant, the
 * super-admin console). Use sparingly; every call is a potential
 * confused-deputy attack vector.
 */
export async function withSuperAdminContext<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!RLS_ENABLED) return fn(prisma as unknown as Tx);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.user_role', 'super_admin', true)`,
    );
    return fn(tx as unknown as Tx);
  });
}

/** Whether RLS is the active enforcement (i.e. the app is on Postgres). */
export function isRlsEnabled(): boolean {
  return RLS_ENABLED;
}
