/**
 * Per-tenant lake storage — file lifecycle + connection pool.
 *
 * Each tenant gets their own SQLite file under `lake/<tenantId>.db`. Why
 * SQLite, not DuckDB? Two reasons:
 *
 *   1. Already in the dependency tree (better-sqlite3 powers the existing
 *      Excel uploader + the sample warehouse). Adding a DuckDB native
 *      binary on Windows is a known install-pain — Phase 2 swaps it in
 *      once the rest of the lake surface has bake-time. See ROADMAP-DATA-
 *      LAYER.md "How this maps onto Curf today".
 *
 *   2. Phase 1 caps storage at 100MB community / 5GB Growth. SQLite handles that
 *      bracket fine; the columnar perf benefit of DuckDB doesn't kick in
 *      until tables get large enough to start scanning meaningfully.
 *
 * Connection caching: open files lazily, keep them around for a short
 * window, close on inactivity. We're not at the scale where a connection
 * pool matters yet — single-process Next dev server can hold ~100 open
 * file handles without breaking a sweat.
 */
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// better-sqlite3's default export is both a class and a namespace, so using
// `Database` directly as a type fails with "Cannot use namespace as a type".
// `InstanceType<typeof Database>` resolves to the instance shape regardless.
type DB = InstanceType<typeof Database>;

const LAKE_DIR = process.env.CURF_LAKE_DIR
  ? process.env.CURF_LAKE_DIR
  : path.join(process.cwd(), "lake");

/**
 * Lazy-init the lake directory. Idempotent — many calls per request,
 * the cost is one stat per call which is fine.
 */
function ensureLakeDir(): void {
  if (!fs.existsSync(LAKE_DIR)) {
    fs.mkdirSync(LAKE_DIR, { recursive: true });
  }
}

export function tenantLakePath(tenantId: string): string {
  // tenantId is a cuid (alnum), no path traversal possible. Belt-and-
  // suspenders: strip anything that's not [A-Za-z0-9_-] just in case.
  const safe = tenantId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(LAKE_DIR, `${safe}.db`);
}

/**
 * Connection cache. Key = tenantId. Value = open Database + last-used
 * timestamp. We close idle connections after IDLE_MS to bound the file-
 * descriptor count. Cleared on process exit so HMR / dev restart starts
 * clean.
 */
type CacheEntry = { db: DB; lastUsedAt: number };
const G = globalThis as any;
const CACHE: Map<string, CacheEntry> = G.__curfLakeConns ?? (G.__curfLakeConns = new Map());
const IDLE_MS = 60_000;
let reaperTimer: ReturnType<typeof setInterval> | null = G.__curfLakeReaper ?? null;

function startReaperOnce(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of CACHE) {
      if (now - v.lastUsedAt > IDLE_MS) {
        try { v.db.close(); } catch { /* ignore */ }
        CACHE.delete(k);
      }
    }
  }, IDLE_MS);
  // Don't keep the Node process alive solely for the reaper.
  if (typeof reaperTimer.unref === "function") reaperTimer.unref();
  G.__curfLakeReaper = reaperTimer;
}

/**
 * Open the tenant's lake DB, creating the file if missing. Returns a
 * cached handle when one is fresh. The schema-management table
 * (`__lake_meta`) is created lazily on first open.
 */
export function openLake(tenantId: string): DB {
  ensureLakeDir();
  startReaperOnce();
  const cached = CACHE.get(tenantId);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return cached.db;
  }
  const db = new Database(tenantLakePath(tenantId));
  // WAL + FULL fsync = strong durability with low contention. Good defaults
  // for a small file that's frequently appended to.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  bootstrapMeta(db);
  CACHE.set(tenantId, { db, lastUsedAt: Date.now() });
  return db;
}

/** Force-close + drop the cached handle. Used by quota / drop-table flows. */
export function closeLake(tenantId: string): void {
  const cached = CACHE.get(tenantId);
  if (cached) {
    try { cached.db.close(); } catch { /* ignore */ }
    CACHE.delete(tenantId);
  }
}

/** Disk size of the tenant's lake file in bytes. 0 if missing. */
export function lakeFileSize(tenantId: string): number {
  try { return fs.statSync(tenantLakePath(tenantId)).size; }
  catch { return 0; }
}

/** Delete the entire lake file for a tenant. Used on tenant offboarding. */
export function dropLake(tenantId: string): void {
  closeLake(tenantId);
  const p = tenantLakePath(tenantId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/**
 * Internal — create the meta table that tracks per-table provenance.
 * We mirror this in the LakeTable Prisma row too, but a local copy here
 * means single-file inspection (e.g. via `sqlite3` CLI) shows enough
 * context to debug without consulting the platform DB.
 */
function bootstrapMeta(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS __lake_meta (
      table_name TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_config_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      row_count INTEGER NOT NULL DEFAULT 0
    )
  `);
}

/**
 * Convert a free-form table name to the safe identifier we use as the
 * actual SQLite table name. Disallows anything that could enable SQL
 * injection through schema names: must start with a letter, then
 * letters/digits/underscores. Names that don't conform get rejected at
 * the API layer; this is the last-resort sanitiser.
 */
export function toSafeTableName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!/^[a-z]/.test(cleaned)) return "t_" + cleaned;
  return cleaned.slice(0, 60);
}

/**
 * Reject a table name that looks like a filesystem path rather than a
 * table name. Nothing downstream actually breaks on one of these — every
 * consumer that turns a table name into an on-disk path (parquet export,
 * materialize, toSafeTableName() above) re-sanitizes independently — but a
 * catalog entry literally named "../../../etc/passwd" (verbatim from an
 * uploaded file's name, e.g. `<input type=file>` on a maliciously-named
 * local file) is confusing to show in the UI and needless to tolerate.
 * Caught here, once, before it's ever persisted — defense-in-depth on top
 * of the path-construction sanitization, not a replacement for it.
 */
export function rejectPathLikeName(name: string): string | null {
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name.includes("\0")) {
    return `Table name "${name}" contains path separators — pick a plain name instead.`;
  }
  return null;
}
