/**
 * Big lake writes on a worker thread.
 *
 * better-sqlite3 is synchronous: a statement that writes a million rows
 * holds Node's event loop for as long as it runs — ten seconds and more
 * for a chain's stock file — and this app runs as a single replica, so
 * every other request waits, health checks included. runLakeTransaction()
 * runs a list of statements in ONE transaction on a worker thread with its
 * own connection to the tenant's lake file. WAL mode lets the main thread's
 * connection keep reading the old tables until the worker commits; a
 * failure rolls the whole list back.
 *
 * The worker is plain JS evaluated from a string (no bundler path to
 * resolve) and loads the same better-sqlite3 the app uses. For the few
 * writes big enough to matter — standard-table merges and the retail
 * figures (tables.ts); everything row-sized stays on the main thread.
 *
 * runLakeRead() takes a report's lake query off the main thread too, with a
 * time limit (in a child process — see there).
 */
import { Worker } from "node:worker_threads";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { openLake, tenantLakePath } from "./storage";

export type LakeStatement = {
  sql: string;
  params?: unknown[];
  /** "run" (default) returns the rows changed; "get" the first row; "all" every row. */
  mode?: "run" | "get" | "all";
};

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.driver);
const db = new Database(workerData.file, { timeout: 30000 });
try {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  const out = db.transaction(() => workerData.statements.map((s) => {
    const stmt = db.prepare(s.sql);
    const params = s.params || [];
    if (s.mode === "get") return stmt.get(...params) ?? null;
    if (s.mode === "all") return stmt.all(...params);
    return stmt.run(...params).changes;
  }))();
  parentPort.postMessage({ ok: true, out });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
} finally {
  db.close();
}
`;

/**
 * The app's own better-sqlite3, as a plain directory path the worker
 * require()s. Not require.resolve / createRequire(): webpack rewrites those
 * into a numeric module id in the production server bundle (dev mode left
 * them alone, so only a real build showed it).
 */
function driver(): string {
  return path.join(process.cwd(), "node_modules", "better-sqlite3");
}

// ---------------------------------------------------------------------------
// Reads with a time limit
// ---------------------------------------------------------------------------

/**
 * A report's lake query, off the main thread, stopped after `timeoutMs`. On
 * the main thread one slow query (a GROUP BY over a million rows, a join
 * missing its condition) froze every workspace's requests until it
 * finished; here the caller gets an error when time is up and the app keeps
 * serving throughout.
 *
 * Reads go to READ_PROCESSES small child processes, not threads: SQLite
 * can't be interrupted from outside while it's inside one long step, and a
 * terminated thread keeps running that step — on a one-CPU pod, a runaway
 * query would go on eating the CPU after it had been "stopped". A child
 * process is killed outright. Each takes one query at a time; more wait in
 * a queue. Each query opens the file read-only and closes it again: no
 * handle outlives a query, so a lake file replaced by a restore is never
 * read through a stale one.
 */
const READ_PROCESSES = 2;

const READ_CHILD_SOURCE = `
const Database = require(process.env.CURF_LAKE_DRIVER);
process.on("message", (q) => {
  let db;
  try {
    db = new Database(q.file, { readonly: true, fileMustExist: true });
    const rows = [];
    for (const row of db.prepare(q.sql).iterate(q.params)) {
      if (rows.length === q.cap) throw new Error(q.capMessage);
      rows.push(row);
    }
    process.send({ ok: true, rows });
  } catch (e) {
    process.send({ ok: false, error: String((e && e.message) || e) });
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
});
process.on("disconnect", () => process.exit(0));
`;

type ReadJob = {
  file: string; sql: string; params: unknown; cap: number; capMessage: string; timeoutMessage: string; timeoutMs: number;
  resolve: (rows: Array<Record<string, unknown>>) => void; reject: (e: Error) => void;
};
type Slot = { child: ChildProcess | null; job: ReadJob | null; timer: ReturnType<typeof setTimeout> | null };

const G = globalThis as any;
const slots: Slot[] = G.__curfLakeReadSlots ?? (G.__curfLakeReadSlots = Array.from({ length: READ_PROCESSES }, () => ({ child: null, job: null, timer: null })));
const queue: ReadJob[] = G.__curfLakeReadQueue ?? (G.__curfLakeReadQueue = []);

function spawnReader(slot: Slot): ChildProcess {
  const child = spawn(process.execPath, ["-e", READ_CHILD_SOURCE], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    serialization: "advanced", // rows keep their types (Buffer for BLOBs)
    // Only what it needs — none of the app's secrets (DATABASE_URL, keys).
    env: {
      NODE_ENV: process.env.NODE_ENV,
      CURF_LAKE_DRIVER: driver(),
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    },
  });
  // An idle reader doesn't keep the app's process alive.
  child.unref();
  (child as any).channel?.unref?.();
  child.on("message", (m: { ok: boolean; rows?: Array<Record<string, unknown>>; error?: string }) => {
    if (slot.child !== child) return; // one given up on may still answer
    const job = slot.job;
    if (!job) return;
    (child as any).channel?.unref?.();
    finish(slot);
    if (m.ok) job.resolve(m.rows ?? []); else job.reject(new Error(m.error));
  });
  const lost = (why: string) => {
    if (slot.child !== child) return; // already replaced
    slot.child = null;
    const job = slot.job;
    finish(slot);
    job?.reject(new Error(why));
  };
  child.on("error", (e) => lost(String(e?.message ?? e)));
  child.on("exit", (code, signal) => lost(`The lake reader stopped (${signal ?? code}) before answering.`));
  return child;
}

function finish(slot: Slot) {
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  slot.job = null;
  setImmediate(pump);
}

function pump() {
  for (const slot of slots) {
    if (slot.job || queue.length === 0) continue;
    const job = queue.shift()!;
    const child = (slot.child ??= spawnReader(slot));
    slot.job = job;
    slot.timer = setTimeout(() => {
      // Past its limit: answer the caller, kill the reader, move on.
      slot.child = null;
      finish(slot);
      job.reject(new Error(job.timeoutMessage));
      child.kill("SIGKILL");
    }, job.timeoutMs);
    // Waiting on an answer keeps the channel referenced; idle, it isn't.
    (child as any).channel?.ref?.();
    child.send({ file: job.file, sql: job.sql, params: job.params, cap: job.cap, capMessage: job.capMessage });
  }
}

export function runLakeRead(opts: {
  tenantId: string;
  sql: string;
  /** Bound as better-sqlite3 binds them — an object of named values, or an array. */
  params: unknown;
  /** More rows than this is an error (capMessage), not a silent cut. */
  cap: number;
  capMessage: string;
  timeoutMs: number;
  timeoutMessage: string;
}): Promise<Array<Record<string, unknown>>> {
  openLake(opts.tenantId); // the file exists before a read-only open
  return new Promise((resolve, reject) => {
    queue.push({ ...opts, file: tenantLakePath(opts.tenantId), resolve, reject });
    pump();
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function runLakeTransaction(tenantId: string, statements: LakeStatement[]): Promise<unknown[]> {
  // The file and its __lake_meta table exist before the worker opens it.
  openLake(tenantId);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { driver: driver(), file: tenantLakePath(tenantId), statements },
    });
    worker.once("message", (m: { ok: boolean; out?: unknown[]; error?: string }) =>
      settle(() => (m.ok ? resolve(m.out ?? []) : reject(new Error(m.error)))));
    worker.once("error", (e) => settle(() => reject(e)));
    worker.once("exit", (code) => settle(() => reject(new Error(`Lake worker exited with code ${code} before finishing.`))));
  });
}
