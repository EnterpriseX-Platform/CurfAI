/**
 * Backups and branches live on the lake volume. They defaulted to
 * process.cwd()/lake/..., which is read-only in the deployed image: every
 * snapshot on prod (manual, nightly, restore's safety copy, Master
 * Builder's pre-rebuild copy) failed with EACCES and none was ever written.
 * Branches (paid) are checked in branchesRoot.test.ts.
 */
import path from "node:path";
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.CURF_LAKE_DIR = "/data/lake";
  delete process.env.CURF_LAKE_BACKUP_DIR;
  delete process.env.CURF_LAKE_BRANCH_DIR;
});

import { lakeRoot } from "./storage";
import { tenantBackupDir } from "./backup";

describe("lake storage roots on a deployment (CURF_LAKE_DIR set)", () => {
  it("keeps backups on the lake volume", () => {
    expect(lakeRoot()).toBe("/data/lake");
    expect(tenantBackupDir("t1")).toBe(path.join("/data/lake", "backups", "t1"));
  });
});
