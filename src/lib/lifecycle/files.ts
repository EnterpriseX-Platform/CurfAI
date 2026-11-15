/**
 * Where a workspace's data lives on disk, and removing all of it.
 *
 * A workspace is more than its Postgres rows: a lake file (SQLite, or DuckDB for the paid engine) with its write-ahead
 * sidecars, imported Excel files, lake branches, backups, Parquet copies of materialized views, staged uploads, lake
 * assets and the exports this module makes. Deleting the workspace's rows leaves every one of those behind, so a purge
 * that stopped at the database would tell the customer "deleted" while their data sat on a volume.
 *
 * The paths come from the same functions that wrote the files (so they cannot drift), and every removal is checked:
 * the workspace id must look like an id, and each target must be a directory (or file) whose own name is that id —
 * a recursive delete is only ever pointed at something that is unmistakably one workspace's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ee } from "@/ee";
import type { FileTarget } from "@/lib/ee/types";
import { lakeRoot, tenantLakePath } from "@/lib/lake/storage";
import { tenantUploadRoot } from "@/lib/connections/excelImport";
import { tenantBackupDir } from "@/lib/lake/backup";
import { tenantDir as tenantStagedUploadsDir } from "@/lib/lake/uploadStaging";

export type { FileTarget };

const SAFE_ID = /^[A-Za-z0-9_-]{6,64}$/;

export class UnsafeTenantIdError extends Error {
  constructor(id: string) { super(`refusing to touch files for a workspace id that is not an id: ${JSON.stringify(id).slice(0, 80)}`); }
}

export function assertSafeTenantId(id: string): string {
  if (!SAFE_ID.test(id)) throw new UnsafeTenantIdError(id);
  return id;
}

/** Where this workspace's exports are written (lib/lifecycle/export.ts). */
export function exportsDir(tenantId: string): string {
  return path.join(lakeRoot(), "exports", assertSafeTenantId(tenantId));
}

/**
 * Every place a workspace's data is kept on disk. Not checked for existence. The SQLite lake, imports, backups, staged
 * uploads and exports are in every edition; the paid lake (DuckDB, branches, Parquet, assets) adds its own through
 * `ee.lifecycle`, so the Community code never imports it.
 */
export async function workspaceFileTargets(tenantId: string): Promise<FileTarget[]> {
  assertSafeTenantId(tenantId);
  const sqlite = tenantLakePath(tenantId);
  return [
    { what: "lake (SQLite)", path: sqlite, kind: "file" },
    { what: "lake (SQLite WAL)", path: sqlite + "-wal", kind: "file" },
    { what: "lake (SQLite shared memory)", path: sqlite + "-shm", kind: "file" },
    { what: "lake (SQLite journal)", path: sqlite + "-journal", kind: "file" },
    { what: "imported files", path: tenantUploadRoot(tenantId), kind: "dir" },
    { what: "backups", path: tenantBackupDir(tenantId), kind: "dir" },
    { what: "staged uploads", path: tenantStagedUploadsDir(tenantId), kind: "dir" },
    { what: "exports", path: exportsDir(tenantId), kind: "dir" },
    ...((await ee.lifecycle?.fileTargets(tenantId)) ?? []),
  ];
}

function sizeOf(p: string): number {
  let total = 0;
  const walk = (q: string) => {
    let st: fs.Stats;
    try { st = fs.lstatSync(q); } catch { return; }
    if (st.isDirectory()) { for (const n of fs.readdirSync(q)) walk(path.join(q, n)); } else total += st.size;
  };
  walk(p);
  return total;
}

function countFiles(p: string): number {
  let n = 0;
  const walk = (q: string) => {
    let st: fs.Stats;
    try { st = fs.lstatSync(q); } catch { return; }
    if (st.isDirectory()) { for (const c of fs.readdirSync(q)) walk(path.join(q, c)); } else n++;
  };
  walk(p);
  return n;
}

export type RemovedFiles = { what: string; existed: boolean; files: number; bytes: number }[];

/**
 * Delete everything the workspace has on disk. Idempotent (a target that is already gone is "didn't exist"), and safe to
 * run again after a failure. Throws before deleting anything if a target is not one that is named for this workspace.
 * `extraTempFiles` are per-backup scratch files in the OS temp dir (curf-snap-<backupId>.db) a time-travel read leaves.
 */
export async function removeWorkspaceFiles(tenantId: string, extraTempFiles: string[] = []): Promise<RemovedFiles> {
  const safe = assertSafeTenantId(tenantId);
  const targets = await workspaceFileTargets(tenantId);

  // Check them all first: nothing is deleted if any one of them is not clearly this workspace's.
  for (const t of targets) {
    const base = path.basename(t.path);
    const named = t.kind === "dir" ? base === safe : base.startsWith(safe);
    if (!named || path.resolve(t.path) === path.resolve(path.dirname(t.path))) {
      throw new Error(`refusing to delete ${t.what}: ${t.path} is not named for workspace ${safe}`);
    }
  }

  const out: RemovedFiles = [];
  for (const t of targets) {
    if (!fs.existsSync(t.path)) { out.push({ what: t.what, existed: false, files: 0, bytes: 0 }); continue; }
    const bytes = sizeOf(t.path);
    const files = countFiles(t.path);
    fs.rmSync(t.path, { recursive: t.kind === "dir", force: true });
    out.push({ what: t.what, existed: true, files, bytes });
  }

  let tmpFiles = 0, tmpBytes = 0;
  for (const name of extraTempFiles) {
    if (!/^curf-snap-[A-Za-z0-9_-]+\.db$/.test(name)) continue;
    const p = path.join(os.tmpdir(), name);
    if (!fs.existsSync(p)) continue;
    tmpBytes += sizeOf(p); tmpFiles++;
    fs.rmSync(p, { force: true });
  }
  if (tmpFiles > 0) out.push({ what: "time-travel scratch files", existed: true, files: tmpFiles, bytes: tmpBytes });
  return out;
}

/** Whether any of the workspace's data is still on disk — what the purge checks after removing it. */
export async function workspaceFilesRemaining(tenantId: string): Promise<string[]> {
  return (await workspaceFileTargets(tenantId)).filter((t) => fs.existsSync(t.path)).map((t) => t.what);
}
