/**
 * SEC-18 (audit 2026-09-27): with no Content-Length (chunked transfer) the
 * chunk PUT read the whole body before any size check. It now stops reading
 * at one chunk's worth.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireAdminOrEditor: vi.fn(async () => ({ id: "u1", tenantId: "t1", role: "admin" })) }));
const staged = vi.hoisted(() => ({ append: vi.fn(async () => ({ received: 3 })) }));
vi.mock("@/lib/lake/uploadStaging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lake/uploadStaging")>()),
  appendStagedChunk: staged.append,
}));

import { PUT } from "./route";
import { UPLOAD_CHUNK_BYTES } from "@/lib/lake/uploadStaging";

/** A streamed body with no Content-Length header, like chunked transfer. */
function streamed(bytes: number): NextRequest {
  const chunk = new Uint8Array(64 * 1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (sent >= bytes) return ctrl.close();
      const n = Math.min(chunk.byteLength, bytes - sent);
      sent += n;
      ctrl.enqueue(chunk.subarray(0, n));
    },
  });
  return new NextRequest("http://localhost:3100/api/lake/uploads/up1?offset=0", { method: "PUT", body, duplex: "half" } as any);
}

describe("PUT /api/lake/uploads/[id] — chunk size", () => {
  it("refuses an over-size streamed body without handing it to storage", async () => {
    const res = await PUT(streamed(UPLOAD_CHUNK_BYTES + 1), { params: { id: "up1" } });
    expect(res.status).toBe(413);
    expect(staged.append).not.toHaveBeenCalled();
  });

  it("accepts a streamed chunk within the limit", async () => {
    const res = await PUT(streamed(3), { params: { id: "up1" } });
    expect(res.status).toBe(200);
    expect(staged.append).toHaveBeenCalledWith(expect.objectContaining({ bytes: expect.any(Buffer) }));
  });
});
