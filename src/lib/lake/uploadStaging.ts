/**
 * Staged uploads — how a file bigger than one request reaches the server.
 *
 * The direct upload (POST /api/lake/tables) takes the whole file in one
 * multipart request and parses it in memory, capped at 50 MB; the ingress
 * refuses anything over 64 MB before the app even sees it. A 127 MB
 * workbook can't get through either. So the browser sends the file in
 * UPLOAD_CHUNK_BYTES pieces, each appended here in order, and the preview
 * and import then read the assembled file from disk.
 *
 * Files live on the lake volume (lakeRoot()/uploads/<tenant>/), next to the
 * data they become — not /tmp, which is the pod's small ephemeral disk.
 * Each upload is `<id>.data` plus `<id>.json` (who, what, how big). Ids are
 * random, and every lookup is by (tenant, id) and checks the uploader, so
 * one workspace can't read, extend or import another's file. Anything left
 * behind (an abandoned upload, a failed import kept for retry) is swept
 * after STALE_MS.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { lakeRoot } from "./storage";

export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** Hard ceiling per file, whatever the tier's lake quota says. */
export const MAX_STAGED_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const STALE_MS = 24 * 60 * 60 * 1000;

export type StagedUpload = {
  id: string;
  tenantId: string;
  userId: string;
  filename: string;
  size: number;
  createdAt: string;
};

export class StagedUploadError extends Error {
  constructor(message: string, readonly status: number, readonly received?: number) {
    super(message);
  }
}

function tenantDir(tenantId: string): string {
  return path.join(lakeRoot(), "uploads", tenantId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

function paths(tenantId: string, id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new StagedUploadError("Upload not found", 404);
  const dir = tenantDir(tenantId);
  return { meta: path.join(dir, `${id}.json`), data: path.join(dir, `${id}.data`) };
}

export async function createStagedUpload(opts: {
  tenantId: string;
  userId: string;
  filename: string;
  size: number;
}): Promise<StagedUpload> {
  await sweepStaleUploads(opts.tenantId);
  const dir = tenantDir(opts.tenantId);
  await fs.promises.mkdir(dir, { recursive: true });
  const upload: StagedUpload = {
    id: crypto.randomBytes(16).toString("hex"),
    tenantId: opts.tenantId,
    userId: opts.userId,
    filename: opts.filename,
    size: opts.size,
    createdAt: new Date().toISOString(),
  };
  const p = paths(opts.tenantId, upload.id);
  await fs.promises.writeFile(p.data, Buffer.alloc(0));
  await fs.promises.writeFile(p.meta, JSON.stringify(upload));
  return upload;
}

/** The upload and how many bytes have arrived, if it exists and belongs to this user. */
export async function getStagedUpload(
  tenantId: string,
  userId: string,
  id: string,
): Promise<{ upload: StagedUpload; dataPath: string; received: number }> {
  const p = paths(tenantId, id);
  let upload: StagedUpload;
  try {
    upload = JSON.parse(await fs.promises.readFile(p.meta, "utf8"));
  } catch {
    throw new StagedUploadError("Upload not found — it may have expired. Choose the file again.", 404);
  }
  if (upload.tenantId !== tenantId || upload.userId !== userId) {
    throw new StagedUploadError("Upload not found — it may have expired. Choose the file again.", 404);
  }
  const received = (await fs.promises.stat(p.data).catch(() => null))?.size ?? 0;
  return { upload, dataPath: p.data, received };
}

/**
 * Append one chunk at `offset`. Chunks must arrive in order; a chunk that is
 * already fully on disk (a retry after a lost response) is acknowledged
 * without writing it twice. Anything else answers 409 with the byte count
 * the server has, so the client can resume from there.
 */
export async function appendStagedChunk(opts: {
  tenantId: string;
  userId: string;
  id: string;
  offset: number;
  bytes: Buffer;
}): Promise<{ received: number; complete: boolean }> {
  const { upload, dataPath, received } = await getStagedUpload(opts.tenantId, opts.userId, opts.id);
  if (opts.bytes.length > UPLOAD_CHUNK_BYTES) {
    throw new StagedUploadError(`A chunk can be at most ${UPLOAD_CHUNK_BYTES} bytes.`, 413, received);
  }
  if (opts.offset + opts.bytes.length <= received) {
    return { received, complete: received === upload.size };
  }
  if (opts.offset !== received) {
    throw new StagedUploadError(`Expected the chunk at byte ${received}.`, 409, received);
  }
  if (received + opts.bytes.length > upload.size) {
    throw new StagedUploadError("This chunk goes past the file size given when the upload started.", 400, received);
  }
  await fs.promises.appendFile(dataPath, opts.bytes);
  const now = received + opts.bytes.length;
  return { received: now, complete: now === upload.size };
}

export async function deleteStagedUpload(tenantId: string, id: string): Promise<void> {
  const p = paths(tenantId, id);
  await Promise.all([fs.promises.rm(p.meta, { force: true }), fs.promises.rm(p.data, { force: true })]);
}

async function sweepStaleUploads(tenantId: string): Promise<void> {
  const dir = tenantDir(tenantId);
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const cutoff = Date.now() - STALE_MS;
  await Promise.all(names.map(async (name) => {
    const full = path.join(dir, name);
    const st = await fs.promises.stat(full).catch(() => null);
    if (st && st.mtimeMs < cutoff) await fs.promises.rm(full, { force: true });
  }));
}
