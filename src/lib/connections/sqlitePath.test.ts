/**
 * A workspace's SQLite/Excel source may only open files the workspace owns,
 * plus the shared sample warehouse. Before this guard, a workspace admin
 * could set `connection` to another workspace's lake file and read it.
 */
import path from "node:path";
import { describe, it, expect } from "vitest";
import { sqlitePathAllowed, openTenantSqlite, SQLITE_PATH_REFUSED } from "./sqlitePath";
import { tenantUploadRoot } from "./excelImport";
import { lakeRoot, tenantLakePath } from "@/lib/lake/storage";

const T = "cmown000000000000000000a";
const OTHER = "cmother0000000000000000b";

describe("sqlitePathAllowed", () => {
  it("allows the workspace's own uploads, its own lake file and the shared sample warehouse", () => {
    expect(sqlitePathAllowed(T, path.join(tenantUploadRoot(T), "uploads", "ex_abc.db"))).toBe(true);
    expect(sqlitePathAllowed(T, tenantLakePath(T))).toBe(true);
    expect(sqlitePathAllowed(T, path.join(process.cwd(), "prisma", "sample.db"))).toBe(true);
    expect(sqlitePathAllowed(T, path.join(lakeRoot(), "_seed-sample-warehouse.db"))).toBe(true);
  });

  it("refuses another workspace's lake file and uploads", () => {
    expect(sqlitePathAllowed(T, tenantLakePath(OTHER))).toBe(false);
    expect(sqlitePathAllowed(T, path.join(tenantUploadRoot(OTHER), "uploads", "ex_abc.db"))).toBe(false);
  });

  it("refuses a traversal out of the workspace's folder and arbitrary server files", () => {
    expect(sqlitePathAllowed(T, path.join(tenantUploadRoot(T), "..", OTHER, "uploads", "x.db"))).toBe(false);
    expect(sqlitePathAllowed(T, "/etc/passwd")).toBe(false);
    expect(sqlitePathAllowed(T, ":memory:")).toBe(false);
    // The upload root's own folder is not a file the workspace uploaded.
    expect(sqlitePathAllowed(T, tenantUploadRoot(T))).toBe(false);
  });

  it("fails closed without a workspace — tenantUploadRoot(\"\") would be every workspace's uploads", () => {
    expect(sqlitePathAllowed("", path.join(tenantUploadRoot(OTHER), "uploads", "x.db"))).toBe(false);
    expect(sqlitePathAllowed("", tenantLakePath(OTHER))).toBe(false);
  });
});

describe("openTenantSqlite", () => {
  it("throws before touching the file system for a refused path", () => {
    expect(() => openTenantSqlite(T, tenantLakePath(OTHER))).toThrow(SQLITE_PATH_REFUSED);
  });
});
