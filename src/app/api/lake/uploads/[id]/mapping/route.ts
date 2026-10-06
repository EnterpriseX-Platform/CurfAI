/**
 * POST /api/lake/uploads/[id]/mapping — how a staged upload's columns map
 * onto a standard dataset (lib/lake/standardDatasets.ts), writing nothing.
 *
 * Body: { dataset, sheet?, textRepair? }. Answers the dataset's fields, the
 * file's columns with a few sample values, the suggested mapping (by header
 * name, only where the values fit) with where each suggestion came from,
 * what still stops the import, and the day/month order of each date column
 * the suggestion uses. The dialog shows all of it and the user confirms or
 * corrects the mapping before POST …/import.
 *
 * With { ai: { current } } it instead asks the workspace's model to match
 * the fields still open in the user's current mapping (aiColumnMapping.ts —
 * checked against the file, never trusted as given) and answers only
 * { aiSuggestions, aiError }. Metered against AI credits like every model call.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminOrEditor } from "@/lib/auth";
import { openUploadRows } from "@/lib/lake/parseFile";
import { repairRow } from "@/lib/lake/textRepair";
import { getStagedUpload, StagedUploadError } from "@/lib/lake/uploadStaging";
import { STANDARD_DATASETS } from "@/lib/lake/standardDatasets";
import { columnDateOrder, headerSignature, mappingProblems, profileColumns, suggestMapping } from "@/lib/lake/columnMapping";
import { loadSavedMapping, standardImportProblem, standardTableExists } from "@/lib/lake/standardImport";
import { aiSuggestMapping } from "@/lib/lake/aiColumnMapping";
import { requireAiCreditsFor } from "@/lib/llm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SAMPLE_ROWS = 2_000;

const FieldSourceSchema = z.union([
  z.object({ column: z.string().min(1) }).strict(),
  z.object({ value: z.string().max(200) }).strict(),
]);

const MappingSchema = z.object({
  dataset: z.enum(["sales_lines", "inventory"]),
  sheet: z.string().min(1).optional(),
  textRepair: z.enum(["mac_roman", "cp1252"]).nullable().optional(),
  // "Ask AI" — match the fields still open in the user's current mapping.
  ai: z.object({ current: z.record(z.string(), FieldSourceSchema) }).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;

  const parsed = MappingSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  const ds = STANDARD_DATASETS[parsed.data.dataset];

  let staged;
  try {
    staged = await getStagedUpload(user.tenantId, user.id, params.id);
  } catch (e) {
    if (e instanceof StagedUploadError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  if (staged.received !== staged.upload.size) {
    return NextResponse.json({ error: "The upload isn't finished yet." }, { status: 409 });
  }

  try {
    const source = await openUploadRows(staged.dataPath, staged.upload.filename, { sheet: parsed.data.sheet });
    const repair = parsed.data.textRepair ?? null;
    const sample: Array<Record<string, unknown>> = [];
    for await (const row of source.rows) {
      sample.push(repair ? repairRow(row, repair) : row);
      if (sample.length >= SAMPLE_ROWS) break;
    }
    const headers = sample.length > 0 ? Object.keys(sample[0]) : [];
    const profiles = profileColumns(sample);
    const samplesOf = (name: string) =>
      [...new Set(sample.map((r) => r[name]).filter((v) => v != null && String(v).trim() !== "").map(String))].slice(0, 3);

    if (parsed.data.ai) {
      // A model call on the workspace's behalf: metered like every other one.
      const credits = await requireAiCreditsFor(user.tenantId);
      if (credits) return credits;
      const ai = await aiSuggestMapping({
        tenantId: user.tenantId,
        userId: user.viaApiKey ? null : user.id,
        ds,
        columns: profiles,
        samples: Object.fromEntries(headers.map((h) => [h, samplesOf(h)])),
        current: parsed.data.ai.current,
      });
      return NextResponse.json({ aiSuggestions: ai.suggestions, aiError: ai.error ?? null });
    }

    const signature = headerSignature(headers);
    const saved = await loadSavedMapping(user, ds, signature);
    const suggestion = suggestMapping(ds, profiles, saved?.mapping, staged.upload.filename);

    // Day/month order per column, decided over the sample the same way the
    // plain upload preview decides it — or as the user confirmed it for this
    // layout last time.
    const dateOrders: Record<string, { order: "mdy" | "dmy"; ambiguous: boolean }> = {};
    for (const name of headers) {
      // What this file's values prove wins; the order confirmed for this
      // layout last time only settles a column that proves nothing.
      const detected = columnDateOrder(sample.map((r) => r[name]));
      const remembered = saved?.dateOrders[name];
      dateOrders[name] = detected.ambiguous && remembered ? { order: remembered, ambiguous: false } : detected;
    }

    const blocked = await standardImportProblem(user, ds);
    return NextResponse.json({
      dataset: {
        id: ds.id,
        tableName: ds.tableName,
        exists: await standardTableExists(user, ds),
        fields: ds.fields.map(({ synonyms: _s, ...f }) => f),
      },
      columns: headers.map((name) => ({ name, samples: samplesOf(name) })),
      mapping: suggestion.mapping,
      origin: suggestion.origin,
      problems: mappingProblems(ds, suggestion.mapping, headers),
      dateOrders,
      signature,
      // The layout was confirmed before: which file, so the dialog can say so.
      savedFrom: saved ? saved.lastFilename ?? "" : null,
      blocked: blocked?.error ?? null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: `Parse failed: ${String(e?.message ?? e).slice(0, 500)}` }, { status: 400 });
  }
}
