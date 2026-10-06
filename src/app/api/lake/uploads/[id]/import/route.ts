/**
 * POST /api/lake/uploads/[id]/import — turn a staged upload into a table.
 *
 * Body, either
 *   { name, sheet?, columnTypes?, columnDateOrders?, textRepair? }
 *     — a new table, as confirmed in the preview dialog; or
 *   { standard: { dataset, mapping, dateOrders? }, sheet?, textRepair? }
 *     — rows mapped onto a standard dataset's table (sales_lines /
 *     inventory, lib/lake/standardDatasets.ts), replacing the period the
 *     file covers.
 * The name, mapping and quota are checked here, synchronously, so an
 * obvious problem answers straight away; the rows themselves are written by
 * a background job (lib/lake/importJob.ts) and this answers 202 with a
 * jobId to poll at GET /api/ai-jobs/[id].
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdminOrEditor } from "@/lib/auth";
import { checkWriteAllowed } from "@/lib/lake/quota";
import { claimImportTarget, LAKE_IMPORT_JOB_KIND, releaseImportTarget, runLakeImportJob } from "@/lib/lake/importJob";
import { newTableNameProblem } from "@/lib/lake/tableRegistration";
import { getStagedUpload, StagedUploadError } from "@/lib/lake/uploadStaging";
import { openUploadRows } from "@/lib/lake/parseFile";
import { repairRow } from "@/lib/lake/textRepair";
import { STANDARD_DATASETS } from "@/lib/lake/standardDatasets";
import { mappingProblems } from "@/lib/lake/columnMapping";
import { standardImportProblem, standardTableExists } from "@/lib/lake/standardImport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FieldSourceSchema = z.union([
  z.object({ column: z.string().min(1) }).strict(),
  z.object({ value: z.string().max(200) }).strict(),
]);

const ImportSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  sheet: z.string().min(1).optional(),
  columnTypes: z.record(z.string(), z.enum(["text", "number", "boolean", "date", "unknown"])).optional(),
  columnDateOrders: z.record(z.string(), z.enum(["mdy", "dmy"])).optional(),
  textRepair: z.enum(["mac_roman", "cp1252"]).nullable().optional(),
  standard: z.object({
    dataset: z.enum(["sales_lines", "inventory"]),
    mapping: z.record(z.string(), FieldSourceSchema),
    dateOrders: z.record(z.string(), z.enum(["mdy", "dmy"])).optional(),
  }).optional(),
}).refine((b) => !!b.name !== !!b.standard, { message: "Give either a new table name or a standard dataset, not both." });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;

  const parsed = ImportSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

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

  const ds = body.standard ? STANDARD_DATASETS[body.standard.dataset] : null;
  let target: string;
  let newTable: boolean;
  if (ds && body.standard) {
    const problem = await standardImportProblem(user, ds);
    if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });
    // Checked against the file's real headers (the first row), with the
    // same text repair the import will apply.
    let headers: string[] = [];
    try {
      const source = await openUploadRows(staged.dataPath, staged.upload.filename, { sheet: body.sheet });
      for await (const row of source.rows) {
        headers = Object.keys(body.textRepair ? repairRow(row, body.textRepair) : row);
        break;
      }
    } catch (e: any) {
      return NextResponse.json({ error: `Parse failed: ${String(e?.message ?? e).slice(0, 500)}` }, { status: 400 });
    }
    const problems = mappingProblems(ds, body.standard.mapping, headers);
    if (problems.length > 0) return NextResponse.json({ error: problems.join(" "), problems }, { status: 400 });
    target = ds.tableName;
    newTable = !(await standardTableExists(user, ds));
  } else {
    target = body.name!;
    const nameProblem = await newTableNameProblem(user, target);
    if (nameProblem) return NextResponse.json({ error: nameProblem.error }, { status: nameProblem.status });
    newTable = true;
  }

  const blocked = await checkWriteAllowed({ tenantId: user.tenantId, estimatedBytes: staged.upload.size, newTable });
  if (blocked) return NextResponse.json({ error: blocked }, { status: 402 });

  if (!claimImportTarget(user.tenantId, target)) {
    return NextResponse.json({ error: `"${target}" is already being imported into. Wait for it to finish.` }, { status: 409 });
  }

  let job;
  try {
    job = await prisma.aiJob.create({
      data: {
        tenantId: user.tenantId,
        kind: LAKE_IMPORT_JOB_KIND,
        status: "running",
        stage: "Reading the file…",
        progressPct: 1,
        createdById: user.viaApiKey ? null : user.id,
      },
    });
  } catch (e) {
    releaseImportTarget(user.tenantId, target);
    throw e;
  }
  void runLakeImportJob({
    jobId: job.id,
    user,
    req,
    uploadId: params.id,
    name: target,
    sheet: body.sheet,
    columnTypeOverrides: body.columnTypes,
    columnDateOrders: body.columnDateOrders,
    textRepair: body.textRepair ?? null,
    standard: body.standard,
  }).catch((e: any) => console.warn("[lake.import] job runner threw:", e?.message ?? e));

  return NextResponse.json({ jobId: job.id, status: "running", pollUrl: `/api/ai-jobs/${job.id}` }, { status: 202 });
}
