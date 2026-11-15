/**
 * What a model call is being made for, beyond its own arguments: today the Master Builder build it belongs to. A build
 * makes hundreds of calls from the planner, the report designer, the gate and verify, so instead of threading an id
 * through every one of them the build runs its work inside `withSpendScope`, and `recordUsage` (lib/llm/index.ts) reads
 * it when it writes the usage row. That is what lets "what did a build cost" be summed from LlmTokenUsage.
 *
 * Same AsyncLocalStorage as lib/dbContext.ts, taken from globalThis for the same reason (this file is reachable from a
 * client bundle through billing.ts, where node:async_hooks does not build). Where there is none, a scope just runs its
 * callback and no call is tagged.
 */
import type { AsyncLocalStorage } from "node:async_hooks";

export type SpendScope = { buildId?: string };

const ALS = (globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage;
const store: { getStore(): SpendScope | undefined; run<R>(s: SpendScope, fn: () => R): R } = ALS
  ? new ALS<SpendScope>()
  : { getStore: () => undefined, run: <R>(_s: SpendScope, fn: () => R): R => fn() };

export function withSpendScope<R>(scope: SpendScope, fn: () => R): R {
  return store.run({ ...store.getStore(), ...scope }, fn);
}

export function currentSpendScope(): SpendScope {
  return store.getStore() ?? {};
}
