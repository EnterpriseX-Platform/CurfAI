import { Prisma, PrismaClient } from "@prisma/client";
import { currentDbContext, runInTransactionScope, type DbContext } from "./dbContext";

const globalForPrisma = globalThis as unknown as { prismaBase?: PrismaClient };

const base =
  globalForPrisma.prismaBase ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prismaBase = base;

// ── Row-level security context (BE-TEN-03) ────────────────────────────
// Postgres filters every tenant-scoped table by the workspace this query
// runs for (prisma/rls/policies.sql); src/lib/dbContext.ts knows which
// workspace that is. This is where the two meet: a query against one of
// those tables, made while a request is bound to a workspace, runs as
//   BEGIN; SELECT set_config(... tenant, user, role ..., true); <query>; COMMIT
// so the settings live exactly as long as the query and never leak to the
// next user of the pooled connection. No bound workspace (cron, sign-in,
// webhooks, withSystemDbContext) = the query runs as it always did.

/** Server only — db.clientBundle.test.ts fails if any "use client" module
 *  imports this, directly or transitively. Should one slip through anyway,
 *  @prisma/client there is its browser stub: no dmmf, and every property
 *  access on the client throws. So module load stays inert in the browser,
 *  as the raw-shim guard below always required — reading Prisma.dmmf at
 *  load once crashed every page that bundled UpgradeLock or featureGate,
 *  back when they reached this module through lib/billing. */
const ON_SERVER = typeof window === "undefined";

/** RLS exists on Postgres only; the SQLite build relies on tenantWhere() alone (lib/rls.ts). */
const RLS_ACTIVE = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");

/** Every model whose table carries a policy — any model with a tenantId
 *  field, plus the four scoped by their own rules. policies.sql finds the
 *  same set from the catalog, so the two can't drift apart. */
const RLS_MODELS = new Set<string>(ON_SERVER ? [
  ...Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === "tenantId"))
    .map((m) => m.name),
  "User", "Tenant", "Organization", "OrgMembership",
] : []);

function setDbContext(client: { $executeRaw: PrismaClient["$executeRaw"] }, ctx: DbContext) {
  return client.$executeRaw`SELECT set_config('app.user_tenant_id', ${ctx.tenantId}, true), set_config('app.user_id', ${ctx.userId}, true), set_config('app.user_role', ${ctx.role}, true)`;
}

const scoped = !ON_SERVER ? base : base.$extends({
  name: "curf-rls-context",
  query: {
    $allModels: {
      async $allOperations({ model, args, query }) {
        if (!RLS_ACTIVE || !RLS_MODELS.has(model)) return query(args);
        const { ctx, inTransaction } = currentDbContext();
        // Inside an interactive transaction the context was set once at
        // BEGIN (below); a nested batch transaction isn't possible there.
        if (!ctx || inTransaction) return query(args);
        const [, result] = await base.$transaction([setDbContext(base, ctx), query(args)]);
        return result;
      },
    },
  },
});

export const prisma = new Proxy(scoped, {
  get(target, prop) {
    if (prop === "$transaction") {
      // An interactive transaction runs on one connection: set the
      // workspace once at its start, and tell the extension above not to
      // wrap the queries inside it again.
      return (arg: unknown, opts?: unknown) => {
        if (typeof arg !== "function") return (target as any).$transaction(arg, opts);
        const { ctx } = currentDbContext();
        return runInTransactionScope(ctx, () =>
          (target as any).$transaction(async (tx: any) => {
            if (RLS_ACTIVE && ctx) await setDbContext(tx, ctx);
            return (arg as (tx: unknown) => unknown)(tx);
          }, opts),
        );
      };
    }
    return Reflect.get(target, prop);
  },
}) as unknown as PrismaClient;
