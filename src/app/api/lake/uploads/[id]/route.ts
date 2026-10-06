/**
 * PUT    /api/lake/uploads/[id]?offset=N — append one chunk (raw bytes body).
 * DELETE /api/lake/uploads/[id]          — cancel and discard the upload.
 *
 * Chunks go in order. A chunk the server already has (a retry after a lost
 * response) is acknowledged without being written twice; an out-of-order
 * one gets 409 with `received`, the byte count to resume from. See
 * lib/lake/uploadStaging.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdminOrEditor } from "@/lib/auth";
import {
  appendStagedChunk,
  deleteStagedUpload,
  getStagedUpload,
  StagedUploadError,
  UPLOAD_CHUNK_BYTES,
} from "@/lib/lake/uploadStaging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The request body, or null as soon as it exceeds `cap` bytes. */
async function readAtMost(req: NextRequest, cap: number): Promise<Buffer | null> {
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => { /* already over the cap */ });
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;

  const offset = Number(req.nextUrl.searchParams.get("offset"));
  if (!Number.isInteger(offset) || offset < 0) {
    return NextResponse.json({ error: "offset must be a non-negative integer" }, { status: 400 });
  }
  // Refuse an oversized body from its declared length before reading it.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > UPLOAD_CHUNK_BYTES) {
    return NextResponse.json({ error: `A chunk can be at most ${UPLOAD_CHUNK_BYTES} bytes.` }, { status: 413 });
  }

  try {
    // Content-Length can be absent (chunked transfer), so the check above
    // isn't enough on its own: read at most one chunk's worth, never the
    // whole body first.
    const bytes = await readAtMost(req, UPLOAD_CHUNK_BYTES);
    if (!bytes) {
      return NextResponse.json({ error: `A chunk can be at most ${UPLOAD_CHUNK_BYTES} bytes.` }, { status: 413 });
    }
    const result = await appendStagedChunk({ tenantId: user.tenantId, userId: user.id, id: params.id, offset, bytes });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof StagedUploadError) {
      return NextResponse.json({ error: e.message, received: e.received }, { status: e.status });
    }
    throw e;
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  try {
    // Ownership check first — only the uploader can discard their upload.
    await getStagedUpload(user.tenantId, user.id, params.id);
    await deleteStagedUpload(user.tenantId, params.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof StagedUploadError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
