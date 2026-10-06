import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// storage.ts reads CURF_LAKE_DIR into a module-level constant at import
// time, so it has to be set before the module graph loads.
const root = vi.hoisted(() => {
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "curf-staging-"));
  process.env.CURF_LAKE_DIR = dir;
  return dir as string;
});

import {
  appendStagedChunk,
  createStagedUpload,
  deleteStagedUpload,
  getStagedUpload,
  StagedUploadError,
  UPLOAD_CHUNK_BYTES,
} from "./uploadStaging";

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.CURF_LAKE_DIR;
});

const T = "tenantA";
const U = "user1";

async function started(size: number) {
  return createStagedUpload({ tenantId: T, userId: U, filename: "big.xlsx", size });
}

describe("staged uploads", () => {
  it("assembles chunks sent in order, on the lake volume", async () => {
    const up = await started(6);
    expect(await appendStagedChunk({ tenantId: T, userId: U, id: up.id, offset: 0, bytes: Buffer.from("abc") }))
      .toEqual({ received: 3, complete: false });
    expect(await appendStagedChunk({ tenantId: T, userId: U, id: up.id, offset: 3, bytes: Buffer.from("def") }))
      .toEqual({ received: 6, complete: true });
    const { dataPath } = await getStagedUpload(T, U, up.id);
    expect(dataPath.startsWith(path.join(root, "uploads", T))).toBe(true);
    expect(fs.readFileSync(dataPath, "utf8")).toBe("abcdef");
  });

  it("acknowledges a chunk it already has without writing it twice", async () => {
    const up = await started(6);
    await appendStagedChunk({ tenantId: T, userId: U, id: up.id, offset: 0, bytes: Buffer.from("abc") });
    expect(await appendStagedChunk({ tenantId: T, userId: U, id: up.id, offset: 0, bytes: Buffer.from("abc") }))
      .toEqual({ received: 3, complete: false });
    const { received } = await getStagedUpload(T, U, up.id);
    expect(received).toBe(3);
  });

  it("answers an out-of-order chunk with 409 and where to resume", async () => {
    const up = await started(6);
    const err = await appendStagedChunk({ tenantId: T, userId: U, id: up.id, offset: 3, bytes: Buffer.from("def") })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StagedUploadError);
    expect(err.status).toBe(409);
    expect(err.received).toBe(0);
  });

  it("refuses bytes past the declared size", async () => {
    const up = await started(2);
    const err = await appendStagedChunk({ tenantId: T, userId: U, id: up.id, offset: 0, bytes: Buffer.from("abc") })
      .catch((e) => e);
    expect(err.status).toBe(400);
  });

  it("refuses a chunk larger than the chunk size", async () => {
    const up = await started(UPLOAD_CHUNK_BYTES + 1);
    const err = await appendStagedChunk({
      tenantId: T, userId: U, id: up.id, offset: 0, bytes: Buffer.alloc(UPLOAD_CHUNK_BYTES + 1),
    }).catch((e) => e);
    expect(err.status).toBe(413);
  });

  it("is invisible to another user and another workspace", async () => {
    const up = await started(3);
    await expect(getStagedUpload(T, "someoneElse", up.id)).rejects.toMatchObject({ status: 404 });
    await expect(getStagedUpload("tenantB", U, up.id)).rejects.toMatchObject({ status: 404 });
    await expect(appendStagedChunk({ tenantId: "tenantB", userId: U, id: up.id, offset: 0, bytes: Buffer.from("x") }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("rejects an id that could be a path", async () => {
    await expect(getStagedUpload(T, U, "../../etc/passwd")).rejects.toMatchObject({ status: 404 });
  });

  it("deletes both files", async () => {
    const up = await started(3);
    await deleteStagedUpload(T, up.id);
    await expect(getStagedUpload(T, U, up.id)).rejects.toMatchObject({ status: 404 });
  });
});
