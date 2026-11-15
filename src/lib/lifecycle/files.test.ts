import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The lake directory is read when the modules load, so it is set first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "curf-files-test-"));
process.env.CURF_LAKE_DIR = root;
let files: typeof import("./files");

beforeAll(async () => { files = await import("./files"); }, 60_000); // loads the whole ee registry

const ID = "cmtest0000abc123";

describe("assertSafeTenantId", () => {
  it("accepts an id and refuses anything that could point a delete somewhere else", async () => {
    const { assertSafeTenantId } = await import("./files");
    expect(assertSafeTenantId(ID)).toBe(ID);
    for (const bad of ["", "..", "../x", "a/b", "a\b", "x".repeat(65), "short", "id with space", "id\0nul", "*"]) {
      expect(() => assertSafeTenantId(bad), bad).toThrow();
    }
  });
});

describe("removeWorkspaceFiles", () => {
  it("removes a workspace's files and directories and nothing else", async () => {
    const targets = await files.workspaceFileTargets(ID);
    const other = await files.workspaceFileTargets("cmother0000xyz99");
    for (const t of [...targets, ...other]) {
      fs.mkdirSync(path.dirname(t.path), { recursive: true });
      if (t.kind === "dir") { fs.mkdirSync(t.path, { recursive: true }); fs.writeFileSync(path.join(t.path, "f.bin"), "data"); }
      else fs.writeFileSync(t.path, "data");
    }
    expect((await files.workspaceFilesRemaining(ID)).length).toBe(targets.length);

    const removed = await files.removeWorkspaceFiles(ID);
    expect(removed.filter((r) => r.existed).length).toBe(targets.length);
    expect(await files.workspaceFilesRemaining(ID)).toEqual([]);
    // The neighbour is untouched.
    expect((await files.workspaceFilesRemaining("cmother0000xyz99")).length).toBe(other.length);
  });

  it("is idempotent: a second pass finds nothing and does not fail", async () => {
    const again = await files.removeWorkspaceFiles(ID);
    expect(again.every((r) => !r.existed)).toBe(true);
  });

  it("refuses an id that is not an id, before touching anything", async () => {
    await expect(files.removeWorkspaceFiles("../..")).rejects.toThrow();
  });
});
