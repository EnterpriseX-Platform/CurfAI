/**
 * POST /api/lake/uploads — start a staged upload.
 *
 * Body: { filename, size }. Answers { uploadId, chunkSize }; the browser
 * then PUTs the file to /api/lake/uploads/[id] in chunkSize pieces,
 * previews it (…/preview) and imports it (…/import). This is how the
 * Tables page takes a file of any size up to MAX_STAGED_UPLOAD_BYTES — the
 * one-request upload (POST /api/lake/tables) stops at 50 MB and the ingress
 * at 64 MB. See lib/lake/uploadStaging.ts.
 *
 * The workspace's lake storage quota is checked here, against the file
 * size, so a file that can't fit is refused before a single chunk is sent.
 * The table cap is not: whether the file becomes a new table or adds days
 * to the standard sales table is only known at …/import, which checks it
 * there. Assuming "a new table" here refused a workspace at its cap the
 * next day's sales file.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminOrEditor } from "@/lib/auth";
import { checkWriteAllowed } from "@/lib/lake/quota";
import { UPLOAD_EXTENSIONS, uploadExtension } from "@/lib/lake/parseFile";
import { createStagedUpload, MAX_STAGED_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from "@/lib/lake/uploadStaging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const StartSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
});

export async function POST(req: NextRequest) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;

  const parsed = StartSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  const { filename, size } = parsed.data;

  const ext = uploadExtension(filename);
  if (!(UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    return NextResponse.json({
      error: `.${ext || "?"} files can't be imported — upload a .xlsx, .csv or .json file.`,
    }, { status: 400 });
  }
  if (size > MAX_STAGED_UPLOAD_BYTES) {
    return NextResponse.json({
      error: `File is ${(size / 1024 / 1024).toFixed(0)} MB — the most one upload can be is ${MAX_STAGED_UPLOAD_BYTES / 1024 / 1024 / 1024} GB.`,
    }, { status: 413 });
  }

  const blocked = await checkWriteAllowed({ tenantId: user.tenantId, estimatedBytes: size });
  if (blocked) return NextResponse.json({ error: blocked }, { status: 402 });

  const upload = await createStagedUpload({ tenantId: user.tenantId, userId: user.id, filename, size });
  return NextResponse.json({ uploadId: upload.id, chunkSize: UPLOAD_CHUNK_BYTES }, { status: 201 });
}
