import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { parseExcelToSqlite, MAX_FILE_BYTES } from "@/lib/connections/excelImport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/data-sources/[id]/excel/refresh
 *
 * Re-parse a freshly-uploaded .xlsx into the SAME per-tenant SQLite file the
 * existing Excel data source already points at. The DataSource row keeps its
 * id, so reports that reference it keep working — they just see new data on
 * the next run.
 *
 * Multipart form fields:
 *   file (required) — the new .xlsx
 *
 * Path-traversal guard: the connection field on the existing row must point
 * inside `var/tenants/<tenantId>/`. Belt-and-braces — the upload route only
 * ever writes there, but we don't want a malformed connection string to
 * cause us to overwrite something else.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const existing = await prisma.dataSource.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true, name: true, kind: true, connection: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.kind !== "excel") {
    return NextResponse.json(
      { error: "Refresh-from-file is only available for Excel-imported connections." },
      { status: 400 },
    );
  }

  const expectedPrefix = path.join(process.cwd(), "var", "tenants", user.tenantId);
  if (!existing.connection?.startsWith(expectedPrefix)) {
    // Either the row points outside the tenant tree (impossible via the upload
    // route, but defensive) or the field is empty. Refuse rather than write
    // somewhere unexpected.
    return NextResponse.json(
      { error: "Existing connection points outside the tenant upload directory; refusing to overwrite." },
      { status: 500 },
    );
  }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 }); }

  const fileEntry = form.get("file");
  if (!(fileEntry instanceof File)) {
    return NextResponse.json({ error: 'Missing "file" field' }, { status: 400 });
  }
  if (fileEntry.size === 0) {
    return NextResponse.json({ error: "File is empty" }, { status: 400 });
  }
  if (fileEntry.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: `File exceeds the ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB cap.` },
      { status: 413 },
    );
  }

  const originalFilename = (fileEntry as any).name || "upload.xlsx";
  const buf = Buffer.from(await fileEntry.arrayBuffer());

  // The parser deletes the existing file before writing — that's the same
  // path/dbPath the row already references. Reports keep their FK reference;
  // queries against them will just see the new data on next run.
  const parseResult = await parseExcelToSqlite(buf, existing.connection, originalFilename);
  if (!parseResult.ok) {
    // The original file may already be unlinked at this point. If so the
    // connection is broken; surface the error with that warning.
    const stillThere = fs.existsSync(existing.connection);
    return NextResponse.json(
      {
        error: parseResult.error,
        connectionBroken: !stillThere,
      },
      { status: 400 },
    );
  }

  const updated = await prisma.dataSource.update({
    where: { id: existing.id },
    data: { discoveredSchemaJson: JSON.stringify(parseResult.schema) },
    select: { id: true, name: true, kind: true },
  });

  recordAudit({
    user,
    kind: "datasource.update",
    target: existing.id,
    req,
    meta: {
      name: existing.name,
      kind: "excel",
      action: "refresh-from-file",
      sourceFilename: originalFilename,
      fileSize: buf.byteLength,
      tableCount: parseResult.schema.tables.length,
      rowCount: parseResult.schema.tables.reduce((acc, t) => acc + t.rowCount, 0),
    },
  });

  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    kind: updated.kind,
    schema: parseResult.schema,
  });
}
