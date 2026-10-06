/**
 * POST /api/lake/uploads/[id]/preview — detected schema of a staged upload,
 * writing nothing. Same answer shape as POST /api/lake/tables/preview, built
 * by the same buildUploadPreview(), but from a leading sample streamed off
 * disk instead of the whole file in memory, so it answers in about a
 * second even for a million-row workbook.
 *
 * Body: { sheet?, textRepair? }. textRepair left out means "detect it";
 * null means "leave the text alone" (the user unticked the repair);
 * "mac_roman" / "cp1252" applies that repair to the sample.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminOrEditor } from "@/lib/auth";
import { openUploadRows } from "@/lib/lake/parseFile";
import { detectTextRepair, repairRow } from "@/lib/lake/textRepair";
import { buildUploadPreview } from "@/lib/lake/uploadPreview";
import { getStagedUpload, StagedUploadError } from "@/lib/lake/uploadStaging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Enough rows to type every column the way the whole file would be typed
// in practice, few enough to read in about a second.
const INFER_SAMPLE_ROWS = 2_000;

const PreviewSchema = z.object({
  sheet: z.string().min(1).optional(),
  textRepair: z.enum(["mac_roman", "cp1252"]).nullable().optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;

  const parsed = PreviewSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }

  let staged;
  try {
    staged = await getStagedUpload(user.tenantId, user.id, params.id);
  } catch (e) {
    if (e instanceof StagedUploadError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  if (staged.received !== staged.upload.size) {
    return NextResponse.json({
      error: `The upload isn't finished — ${staged.received} of ${staged.upload.size} bytes arrived.`,
    }, { status: 409 });
  }

  try {
    const source = await openUploadRows(staged.dataPath, staged.upload.filename, { sheet: parsed.data.sheet });
    const sample: Array<Record<string, unknown>> = [];
    let exhausted = true;
    for await (const row of source.rows) {
      if (sample.length >= INFER_SAMPLE_ROWS) { exhausted = false; break; }
      sample.push(row);
    }

    const detected = detectTextRepair(sample);
    const applied = parsed.data.textRepair === undefined ? detected : parsed.data.textRepair;
    const rows = applied ? sample.map((r) => repairRow(r, applied)) : sample;

    // The whole file fit in the sample: the count is exact. Otherwise it is
    // what the file declared (a sheet's <dimension>, a CSV's line count).
    const declared = exhausted ? null : await source.expectedRows();
    return NextResponse.json(buildUploadPreview({
      filename: staged.upload.filename,
      rows,
      rowCount: exhausted ? sample.length : declared ?? sample.length,
      rowCountIsEstimate: !exhausted,
      sheets: source.sheets,
      sheet: source.sheet,
      textRepair: { detected, applied },
    }));
  } catch (e: any) {
    return NextResponse.json({ error: `Parse failed: ${String(e?.message ?? e).slice(0, 500)}` }, { status: 400 });
  }
}
