/**
 * /api/lake/tables/preview — parse a file and return its detected schema
 * WITHOUT writing anything. The confirm-before-commit half of the upload
 * flow: TablesManager's upload dialog calls this first, shows the
 * detected columns with a type override per column, and only on explicit
 * confirm does the browser POST the same file to POST /api/lake/tables
 * (this time with any corrected types) to actually create the table.
 *
 * Before this endpoint existed, upload committed blind — the first
 * feedback a user got about how their columns were typed was an empty
 * chart-type picker somewhere else in the product, with nothing explaining
 * why. No quota check here (nothing is written); the same size cap as the
 * real create route still applies, since parsing a huge file costs real
 * CPU/memory even without a disk write.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { inferColumns } from "@/lib/lake/tables";
import { detectDateOrder } from "@/lib/lake/valueClean";
import { parseUploadWithMeta } from "@/lib/lake/parseFile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // Mirrors POST /api/lake/tables's own Phase 1 cap.
const SAMPLE_ROWS = 20;

export async function POST(req: NextRequest) {
  try {
    return await previewImpl(req);
  } catch (e: any) {
    const msg = (e?.message ?? String(e)).slice(0, 500);
    console.warn(`[POST /api/lake/tables/preview] unexpected error: ${msg}`);
    return NextResponse.json({ error: `Server error: ${msg}` }, { status: 500 });
  }
}

async function previewImpl(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return NextResponse.json({ error: "Expected a multipart file upload" }, { status: 400 });
  }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "Invalid form-data" }, { status: 400 }); }

  const fileEntry = form.get("file");
  if (!(fileEntry instanceof File) || fileEntry.size === 0) {
    return NextResponse.json({ error: "Missing or empty file" }, { status: 400 });
  }
  if (fileEntry.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({
      error: `File is ${(fileEntry.size / 1024 / 1024).toFixed(1)} MB — Phase 1 cap is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB per upload.`,
    }, { status: 413 });
  }

  const filename = (fileEntry as any).name ?? "upload";
  // Which workbook sheet to read. Absent on the first preview (the parser
  // picks sheet 1 and tells us what it found); set when the user switches
  // sheets in the dialog, which re-previews rather than guessing locally.
  const sheetEntry = form.get("sheet");
  const sheet = typeof sheetEntry === "string" && sheetEntry.length > 0 ? sheetEntry : undefined;

  const buf = Buffer.from(await fileEntry.arrayBuffer());
  let parsed: Awaited<ReturnType<typeof parseUploadWithMeta>>;
  try {
    parsed = await parseUploadWithMeta(buf, filename, { sheet });
  } catch (e: any) {
    return NextResponse.json({ error: `Parse failed: ${e?.message ?? e}` }, { status: 400 });
  }

  const { rows, sheets } = parsed;
  const columns = inferColumns(rows);

  // Date columns whose values prove nothing about day/month order. The
  // detected order on those is a fallback, not a reading of the data, so
  // the dialog asks rather than letting it ride.
  const ambiguousDateColumns = columns
    .filter((c) => c.type === "date")
    .filter((c) => detectDateOrder(rows.map((r) => r[c.name]).filter((v): v is string => typeof v === "string")).ambiguous)
    .map((c) => c.name);
  const base = filename.replace(/\.[^.]+$/, "");
  // One table per sheet, so a multi-sheet workbook needs the sheet in the
  // name — otherwise importing a second sheet proposes a name that already
  // exists and silently replaces the first import.
  const suggestedName = sheets.length > 1 && parsed.sheet ? `${base}_${parsed.sheet}` : base;

  return NextResponse.json({
    suggestedName,
    columns,
    sampleRows: rows.slice(0, SAMPLE_ROWS),
    rowCount: rows.length,
    sheets,
    sheet: parsed.sheet,
    ambiguousDateColumns,
  });
}
