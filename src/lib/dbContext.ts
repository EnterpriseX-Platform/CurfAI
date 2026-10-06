/**
 * Which workspace the current request's database work belongs to — the
 * input to Postgres row-level security (BE-TEN-03).
 *
 * tenantWhere(user) in application code is the first line of tenant
 * isolation; RLS is the second, so one query that forgets its filter still
 * can't read another workspace. For that the database has to know, on every
 * query, whose request it is. This module holds that answer; src/lib/db.ts
 * hands it to Postgres (set_config inside a transaction) on each query
 * against a tenant-scoped model, and prisma/rls/policies.sql filters by it.
 *
 * Where the answer comes from:
 *   - bindRequestDbContext() — called by auth (getSession / requireUser)
 *     once it knows the signed-in user or API key. Stored on Next's own
 *     per-request store, so it holds for the rest of that request — every
 *     await, every component, background work the request started — without
 *     threading a parameter through ~1,200 call sites.
 *   - withSystemDbContext(fn) — no workspace: the few request paths that
 *     legitimately read or write across workspaces (resolving the session's
 *     memberships, creating a new workspace, looking up a share token).
 *   - withTenantDbContext(ctx, fn) — act as a specific workspace, e.g. a
 *     public app page rendering its owner's data for a visitor who is
 *     signed in to a different one.
 *
 * No context at all (cron, webhooks, sign-in, scripts) means "system": the
 * policies pass rows through, as before RLS existed. Nothing here can widen
 * what a request sees beyond what its own workspace already could — the
 * only way to drop the filter is to call withSystemDbContext in code.
 */
import type { AsyncLocalStorage } from "node:async_hooks";
import { requestAsyncStorage } from "next/dist/client/components/request-async-storage.external";

export type DbContext = { tenantId: string; userId: string; role: string };

type Scope = { ctx: DbContext | null; inTransaction?: boolean };

const REQUEST_KEY = Symbol.for("curf.dbContext");

/** The server's AsyncLocalStorage, the same one Next's request store uses
 *  (next/dist/server/node-environment puts it on globalThis). Not imported
 *  from node:async_hooks: db.ts reaches a client bundle through
 *  billing.ts → UpgradeLock.tsx, where that import fails the build. Where
 *  there is none — a client bundle, a plain Node script — scopes simply run
 *  their callback: no request, no workspace, system context. */
const ALS = (globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage;
type Scopes = { getStore(): Scope | undefined; run<R>(store: Scope, fn: () => R): R };
const scopes: Scopes = ALS
  ? new ALS<Scope>()
  : { getStore: () => undefined, run: <R>(_store: Scope, fn: () => R): R => fn() };

function requestStore(): Record<symbol, unknown> | undefined {
  try {
    return requestAsyncStorage.getStore() as unknown as Record<symbol, unknown> | undefined;
  } catch {
    return undefined;
  }
}

type Bound = { ctx: DbContext; pinned: boolean };

/** Tie the rest of this request's database work to the signed-in caller's
 *  workspace (auth calls this). Yields to a pinned binding: the root layout
 *  resolves the session on EVERY page, public ones included, and may do so
 *  after the page has already pinned the workspace it is rendering. */
export function bindRequestDbContext(ctx: DbContext): void {
  const store = requestStore();
  if (!store) return;
  if ((store[REQUEST_KEY] as Bound | undefined)?.pinned) return;
  store[REQUEST_KEY] = { ctx, pinned: false } satisfies Bound;
}

/** For a page that renders another workspace's data by design — a public
 *  app, a share or embed link: run the rest of the request as the owner of
 *  what's being shown, whoever is signed in. */
export function pinRequestDbContext(ctx: DbContext): void {
  const store = requestStore();
  if (store) store[REQUEST_KEY] = { ctx, pinned: true } satisfies Bound;
}

/** The workspace the current query runs for — null = system work. */
export function currentDbContext(): { ctx: DbContext | null; inTransaction: boolean } {
  const scope = scopes.getStore();
  if (scope) return { ctx: scope.ctx, inTransaction: !!scope.inTransaction };
  const bound = requestStore()?.[REQUEST_KEY] as Bound | undefined;
  return { ctx: bound?.ctx ?? null, inTransaction: false };
}

// Every scope awaits its callback INSIDE the scope. A Prisma query is lazy —
// it starts when awaited, not when called — so `() => prisma.x.findMany()`
// handed back un-awaited would run after the scope had already ended, as
// whatever the caller was bound to. Caught by db.rls.integration.test.ts.
function inScope<T>(scope: Scope, fn: () => Promise<T>): Promise<T> {
  return scopes.run(scope, async () => await fn());
}

/** Run `fn` with no workspace filter. Only for work that is cross-workspace by design. */
export function withSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  return inScope({ ctx: null }, fn);
}

/** Run `fn` as `ctx`'s workspace, whatever the request is bound to. */
export function withTenantDbContext<T>(ctx: DbContext, fn: () => Promise<T>): Promise<T> {
  return inScope({ ctx }, fn);
}

/** Used by db.ts's $transaction: queries inside an interactive transaction
 *  share the context it set once at BEGIN instead of opening their own. */
export function runInTransactionScope<T>(ctx: DbContext | null, fn: () => Promise<T>): Promise<T> {
  return inScope({ ctx, inTransaction: true }, fn);
}
