import path from "node:path";
import Database from "better-sqlite3";
import { tenantUploadRoot } from "@/lib/connections/excelImport";
import { lakeRoot, tenantLakePath } from "@/lib/lake/storage";

/**
 * Where a workspace's SQLite or Excel data source may point: a file in its
 * own upload folder (Excel imports land there), its own lake file, or the
 * bundled sample warehouse every workspace shares read-only.
 *
 * `DataSource.connection` used to be opened exactly as stored, and a
 * workspace admin sets it — so any admin (and anyone can be one of their own
 * workspace) could point a source at another workspace's lake file, or any
 * SQLite file on the server, and read it through a report.
 */
export function sqlitePathAllowed(tenantId: string, connection: string): boolean {
  const file = path.resolve(connection.trim());
  const shared = [
    path.resolve(process.cwd(), "prisma", "sample.db"),
    path.resolve(lakeRoot(), "_seed-sample-warehouse.db"),
  ];
  if (shared.includes(file)) return true;
  // No workspace, no private storage: failing closed here matters because
  // tenantUploadRoot("") is the folder holding EVERY workspace's uploads.
  if (!tenantId) return false;
  if (file === path.resolve(tenantLakePath(tenantId))) return true;
  return file.startsWith(path.resolve(tenantUploadRoot(tenantId)) + path.sep);
}

export const SQLITE_PATH_REFUSED = "A SQLite source must be a file uploaded to this workspace.";

/** Open a workspace's SQLite/Excel file read-only, refusing any file outside its own storage. */
export function openTenantSqlite(tenantId: string, connection: string): InstanceType<typeof Database> {
  if (!sqlitePathAllowed(tenantId, connection)) throw new Error(SQLITE_PATH_REFUSED);
  return new Database(connection, { readonly: true, fileMustExist: true });
}
