/**
 * In-process query result cache.
 *
 * Hashes (tenantId, dataSourceId, sql, params) → cached row array, with a TTL
 * (default 30s). Sized as a per-tenant LRU so a noisy tenant can't eat the
 * whole map. Tracks hit/miss/byte counters per tenant so the /admin/usage
 * dashboard can show "cache savings since last restart" without us having to
 * persist anything.
 *
 * Why in-process and not Redis?
 *   - One Curf instance is the unit. Dashboards typically auto-refresh from
 *     the same node behind the LB, and even when they hit a different node,
 *     the second node just becomes its own cache. Worst case: each node pays
 *     the first miss; subsequent reads are free for that node's traffic.
 *   - Avoids a network hop on every query — the whole point is latency.
 *   - Cleared on deploy, which matches the "flush on schema change" instinct.
 *
 * Why not just memoize at the runner level?
 *   - We want explicit metrics (hits/misses/bytes saved), bypass via ?bust=1,
 *     and per-query TTL knobs once we add hot/cold tables.
 *
 * Caveats:
 *   - We deliberately do NOT key on viewer identity. The runner already
 *     enforces source-level visibility (canSeeDataSource). Once the user is
 *     past that gate, a SELECT on the source returns the same rows for every
 *     viewer in the tenant, so cross-viewer caching is safe today. If we add
 *     row-level ACL (predicate-based filtering), this needs a viewer scope.
 *   - REST sources are bypassed: the rows come from a remote URL we don't
 *     control, and small REST responses are cheap to refetch. Cacheing them
 *     would also require keying on the URL+headers, which we'd rather not.
 */

import { createHash } from "crypto";
import type { Row } from "@/lib/reporting/interpolate";

const DEFAULT_TTL_MS = 30 * 1000;
// Per-tenant cap. Very rough — a 100k-row result is ~50MB; capping at 256
// entries gives a reasonable upper bound on heap impact for a small cluster.
// We cap on entry count (not bytes) because measuring exact byte size of a
// JS array is itself expensive.
const MAX_ENTRIES_PER_TENANT = 256;

type CacheEntry = {
  rows: Row[];
  storedAt: number;
  expiresAt: number;
  /** Approximate byte estimate (JSON.stringify length). Used by metrics. */
  approxBytes: number;
  /** Bump on each hit so LRU eviction picks the genuinely-coldest entry. */
  lastTouched: number;
  /** Stored alongside the row payload so per-source bust can do an O(n)
   *  walk without falling back to a full-tenant flush. The dataSourceId is
   *  not in the cache key (we hash everything together) so we have to keep
   *  it on the entry separately. */
  dataSourceId: string;
  /**
   * provenance.ts's hashRows(rows) result, precomputed once on the miss that
   * populated this entry. hashRows is a full SHA-256 pass over every row
   * (sorted keys + JSON.stringify each) — at 50k+ rows that pass alone ran
   * 150-900ms, and it used to re-run on every cache *hit* too because the
   * runner called hashRows(rows) unconditionally after the cache lookup.
   * Reusing it here is what actually makes a cache hit fast; skipping the
   * SQL query alone wasn't the bottleneck at this row count.
   */
  dataHash: string;
};

type TenantCache = {
  entries: Map<string, CacheEntry>; // insertion-ordered → near-LRU when we evict from the front
  metrics: {
    hits: number;
    misses: number;
    bytesServed: number;
    msSaved: number;
    /** When this tenant's metrics were last reset (process restart). */
    since: number;
  };
};

const caches = new Map<string, TenantCache>();

/** Resolve or create the per-tenant cache slot. */
function getTenantCache(tenantId: string): TenantCache {
  let c = caches.get(tenantId);
  if (!c) {
    c = {
      entries: new Map(),
      metrics: { hits: 0, misses: 0, bytesServed: 0, msSaved: 0, since: Date.now() },
    };
    caches.set(tenantId, c);
  }
  return c;
}

/**
 * Key the cache on the *content* of (tenantId, dataSourceId, sql, params).
 * Sorting param keys gives us insensitivity to call-site iteration order,
 * which would otherwise produce duplicate entries for identical queries.
 */
export function buildCacheKey(parts: {
  tenantId: string;
  dataSourceId: string;
  sql: string;
  params: Record<string, unknown>;
}): string {
  const sortedParamKeys = Object.keys(parts.params).sort();
  const canonical = JSON.stringify({
    t: parts.tenantId,
    d: parts.dataSourceId,
    s: parts.sql,
    p: sortedParamKeys.map((k) => [k, parts.params[k]]),
  });
  return createHash("sha1").update(canonical).digest("hex");
}

/**
 * Look up rows (and their precomputed provenance dataHash) by composite key.
 * Returns null on miss / expired / bypass. Bumps the `lastTouched` clock on
 * a hit so the LRU eviction picks something else.
 */
export function getCachedRows(opts: {
  tenantId: string;
  dataSourceId: string;
  sql: string;
  params: Record<string, unknown>;
}): { rows: Row[]; dataHash: string } | null {
  const c = getTenantCache(opts.tenantId);
  const key = buildCacheKey(opts);
  const entry = c.entries.get(key);
  if (!entry) {
    c.metrics.misses++;
    return null;
  }
  if (entry.expiresAt < Date.now()) {
    c.entries.delete(key);
    c.metrics.misses++;
    return null;
  }
  entry.lastTouched = Date.now();
  c.metrics.hits++;
  c.metrics.bytesServed += entry.approxBytes;
  return { rows: entry.rows, dataHash: entry.dataHash };
}

/**
 * Store rows (and their already-computed provenance dataHash — see
 * CacheEntry.dataHash) under the composite key. ttlMs override is honored;
 * otherwise we use DEFAULT_TTL_MS. Records `durationMs` so subsequent hits
 * can claim the time saved (even though the *real* answer is "we skipped
 * re-running the original query AND re-hashing every row, so we saved
 * both").
 */
export function setCachedRows(opts: {
  tenantId: string;
  dataSourceId: string;
  sql: string;
  params: Record<string, unknown>;
  rows: Row[];
  dataHash: string;
  ttlMs?: number;
  /**
   * The wall time the original query took, in ms. Used to credit the
   * "ms saved" metric on a future cache hit.
   */
  durationMs?: number;
}): void {
  const c = getTenantCache(opts.tenantId);
  const key = buildCacheKey(opts);

  // Best-effort byte estimate. We don't pass this to anything that depends
  // on it being exact — it's surfaced in metrics only.
  let approxBytes = 0;
  try {
    approxBytes = JSON.stringify(opts.rows).length;
  } catch {
    approxBytes = opts.rows.length * 64; // rough fallback when rows contain BigInts etc.
  }

  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const entry: CacheEntry = {
    rows: opts.rows,
    storedAt: now,
    expiresAt: now + ttlMs,
    approxBytes,
    lastTouched: now,
    dataSourceId: opts.dataSourceId,
    dataHash: opts.dataHash,
  };

  // If we already had this key, replace in-place (move-to-end semantics so
  // the LRU stays correct). Map preserves insertion order; deleting + re-
  // inserting puts the entry at the back.
  if (c.entries.has(key)) c.entries.delete(key);
  c.entries.set(key, entry);

  // Track the saved ms on writes so a fresh hit can amortize against the
  // miss that produced it; we record it once at write time and credit it on
  // every subsequent hit through bytesServed elsewhere.
  if (opts.durationMs && opts.durationMs > 0) {
    c.metrics.msSaved += opts.durationMs;
  }

  // Evict oldest until under cap. Map iteration is insertion-ordered, which
  // approximates LRU well enough since we re-insert on hit.
  while (c.entries.size > MAX_ENTRIES_PER_TENANT) {
    const oldest = c.entries.keys().next().value as string | undefined;
    if (!oldest) break;
    c.entries.delete(oldest);
  }
}

/**
 * Drop everything for a tenant. Used by the runner when the user passes
 * `?bust=1` or when a writes path mutates a lake table (so dashboards bound
 * to it see fresh rows on next refresh, not the stale cache).
 */
export function bustTenantCache(tenantId: string): void {
  const c = caches.get(tenantId);
  if (!c) return;
  c.entries.clear();
}

/**
 * Drop entries that touch a given data source. Cheaper than busting the
 * whole tenant — useful when a single source got reloaded (CSV reupload,
 * lake table mutated, MV refresh). Walks the per-tenant entries (capped at
 * MAX_ENTRIES_PER_TENANT, so always small) and removes only entries whose
 * payload was produced from this source.
 */
export function bustForDataSource(tenantId: string, dataSourceId: string): void {
  const c = caches.get(tenantId);
  if (!c) return;
  for (const [key, entry] of c.entries) {
    if (entry.dataSourceId === dataSourceId) c.entries.delete(key);
  }
}

/**
 * Per-tenant counters for /admin/usage. Numbers are cumulative since the
 * last process restart. Hit-rate is computed inline because plotting it
 * separately is the dashboard's job.
 */
export type CacheMetrics = {
  hits: number;
  misses: number;
  bytesServed: number;
  msSaved: number;
  hitRate: number; // 0..1
  entries: number;
  approxBytesResident: number;
  since: Date;
};

export function getCacheMetrics(tenantId: string): CacheMetrics {
  const c = caches.get(tenantId);
  if (!c) {
    return {
      hits: 0, misses: 0, bytesServed: 0, msSaved: 0,
      hitRate: 0, entries: 0, approxBytesResident: 0, since: new Date(),
    };
  }
  const total = c.metrics.hits + c.metrics.misses;
  const hitRate = total > 0 ? c.metrics.hits / total : 0;
  let approxBytesResident = 0;
  for (const e of c.entries.values()) approxBytesResident += e.approxBytes;
  return {
    hits: c.metrics.hits,
    misses: c.metrics.misses,
    bytesServed: c.metrics.bytesServed,
    msSaved: c.metrics.msSaved,
    hitRate,
    entries: c.entries.size,
    approxBytesResident,
    since: new Date(c.metrics.since),
  };
}

/**
 * Tiered duration formatter for the "Time saved" stat. The cumulative-ms
 * counter often sits in the sub-second range when the underlying queries
 * are fast (a 30-row SQLite SELECT can finish in < 1ms; ten cache hits
 * across that report saves ~10ms total). Rendering "0.0s" makes the cache
 * look broken when it's actually doing its job — show ms when below 1s,
 * seconds in the mid-range, minutes when meaningful.
 *
 *   < 1 ms       → "<1ms"
 *   < 1000 ms    → "473ms"
 *   < 60 s       → "12.5s"
 *   ≥ 60 s       → "3m 14s"
 */
export function formatMsSaved(totalMs: number): string {
  if (totalMs <= 0) return "—";
  if (totalMs < 1) return "<1ms";
  if (totalMs < 1000) return `${Math.round(totalMs)}ms`;
  if (totalMs < 60_000) return `${(totalMs / 1000).toFixed(1)}s`;
  const mins = Math.floor(totalMs / 60_000);
  const secs = Math.round((totalMs % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

/** Reset only the counters, leave cached rows in place. Admins click this
 * from the dashboard when they want a clean baseline after a deploy. */
export function resetCacheMetrics(tenantId: string): void {
  const c = caches.get(tenantId);
  if (!c) return;
  c.metrics = {
    hits: 0, misses: 0, bytesServed: 0, msSaved: 0, since: Date.now(),
  };
}
