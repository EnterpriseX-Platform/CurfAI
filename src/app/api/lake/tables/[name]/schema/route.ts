/**
 * /api/lake/tables/[name]/schema — POST schema-mutation actions.
 *
 * Body shape (discriminated by `action`):
 *   { action: "addColumn", name, type?, defaultValue? }
 *   { action: "addFormula", name, formula }      — a formula column (lib/lake/formulaColumns.ts)
 *   { action: "setFormula", name, formula }      — change a formula column's formula
 *   { action: "renameColumn", oldName, newName }
 *   { action: "dropColumn", name }
 *   { action: "retype", name, type }
 *
 * A formula that doesn't check out is a 400 with `at` (where in the
 * formula) and `code`, for the editor to point at, and `key` + `params` to
 * say it in the reader's language (formula/messages.ts).
 *
 * Builders who can read the table (lib/lake/tableAccess.ts). After every successful
 * mutation we re-introspect the schema and refresh the LakeTable row's
 * cached schemaJson + bump updatedAt so the browser tab list reflects
 * the change without a hard reload.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { addColumn, renameColumn, dropColumn, retypeColumn, setFormulaColumn, getTable, previewRows } from "@/lib/lake/tables";
import { mergeGovernanceMetadata, parseSchemaJson, attachSamples } from "@/lib/lake/schemaGovernance";
import { FormulaError, MAX_FORMULA_LENGTH } from "@/lib/lake/formula/parse";
import { bustLakeCacheForTenant } from "@/lib/lake/bust";
import { ee } from "@/ee";
import { lakeTableFor } from "@/lib/lake/tableAccess";
import { redactSamples } from "@/lib/lake/redaction";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("addColumn"),
    name: z.string().min(1).max(60),
    type: z.enum(["text", "number", "boolean", "date"]).optional(),
    defaultValue: z.string().max(1000).optional(),
  }),
  z.object({ action: z.literal("addFormula"), name: z.string().min(1).max(60), formula: z.string().min(1).max(MAX_FORMULA_LENGTH) }),
  z.object({ action: z.literal("setFormula"), name: z.string().min(1).max(60), formula: z.string().min(1).max(MAX_FORMULA_LENGTH) }),
  z.object({ action: z.literal("renameColumn"), oldName: z.string().min(1).max(60), newName: z.string().min(1).max(60) }),
  z.object({ action: z.literal("dropColumn"), name: z.string().min(1).max(60) }),
  // Recovery path for a column inference got wrong (or that predates the
  // cleaning behaviour entirely — a table uploaded before it shipped still
  // has raw "$1,299.00"-style text on disk). "unknown" is excluded: it's
  // never a meaningful RETYPE target, only something a column starts as.
  z.object({
    action: z.literal("retype"),
    name: z.string().min(1).max(60),
    type: z.enum(["text", "number", "boolean", "date"]),
  }),
]);

export async function POST(req: NextRequest, { params }: { params: { name: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // A builder who can read the table (an owner-only table reads only for its
  // owner) — one they can't read is not found, never changeable.
  const access = await lakeTableFor(user, decodeURIComponent(params.name), "build");
  if (access instanceof NextResponse) return access;
  const { row, viewer } = access;

  const body = await req.json().catch(() => ({}));
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  let retypeResult: { updated: number; unchanged: number } | undefined;
  try {
    if (parsed.data.action === "addColumn") {
      await addColumn({
        tenantId: user.tenantId, tableName: row.name, columnName: parsed.data.name,
        type: parsed.data.type, defaultValue: parsed.data.defaultValue,
      });
    } else if (parsed.data.action === "addFormula" || parsed.data.action === "setFormula") {
      await setFormulaColumn({
        tenantId: user.tenantId, tableName: row.name, columnName: parsed.data.name,
        formula: parsed.data.formula, replace: parsed.data.action === "setFormula",
      });
    } else if (parsed.data.action === "renameColumn") {
      await renameColumn({ tenantId: user.tenantId, tableName: row.name, oldName: parsed.data.oldName, newName: parsed.data.newName });
    } else if (parsed.data.action === "dropColumn") {
      await dropColumn({ tenantId: user.tenantId, tableName: row.name, columnName: parsed.data.name });
    } else if (parsed.data.action === "retype") {
      retypeResult = await retypeColumn({
        tenantId: user.tenantId, tableName: row.name,
        columnName: parsed.data.name, type: parsed.data.type,
      });
    }
  } catch (e: any) {
    if (e instanceof FormulaError) return NextResponse.json({ error: e.message, ...(e.at >= 0 ? { at: e.at } : {}), code: e.code, key: e.key, params: e.params }, { status: 400 });
    return NextResponse.json({ error: e?.message ?? "Schema change failed" }, { status: 400 });
  }

  // The table's shape or contents just changed: cached query results that read
  // it are stale.
  setImmediate(() => { void bustLakeCacheForTenant(user.tenantId, row.name); });

  // Refresh the cached schemaJson on the catalog row from the lake itself
  // (getTable): types re-derived from the actual (now-cleaned) data
  // rather than trusting the requested retype type verbatim — if most cells
  // genuinely couldn't clean to the requested type (a real mismatch, not
  // just an inference miss), the persisted type honestly reflects that
  // instead of lying about it — and formula columns listed with their
  // formula, which a sample of values can't show.
  //
  // Governance metadata (redaction tags, allowlists, join hints) can't be
  // re-derived from data, so it's merged back from the existing row —
  // writing the bare inferred columns silently stripped every column's
  // `sensitivity` on ANY schema change, un-redacting PII for non-admin
  // viewers. A rename carries its column's tags to the new name; a formula
  // column's are derived from the columns it reads.
  const sample = await previewRows(user.tenantId, row.name, 100);
  const columns = attachSamples((await getTable(user.tenantId, row.name))?.columns ?? [], sample).map((c) =>
    // A new, still-empty column has no values to read a type from: it's what was asked for.
    parsed.data.action === "addColumn" && parsed.data.type && c.name === parsed.data.name && c.sample === undefined
      ? { ...c, type: parsed.data.type }
      : c);
  const fresh = mergeGovernanceMetadata(
    parseSchemaJson(row.schemaJson),
    columns,
    parsed.data.action === "renameColumn" ? { [parsed.data.newName]: parsed.data.oldName } : {},
  );
  await prisma.lakeTable.update({
    where: { id: row.id },
    data: { schemaJson: JSON.stringify(fresh), updatedAt: new Date() },
  });

  // Vector-DB: re-enqueue every column. The drain's textHash check
  // skips columns whose embedded text hasn't changed, so unchanged
  // columns cost zero embedding tokens — only the added/renamed one
  // actually re-embeds. Dropped columns' VectorEmbedding rows stay
  // until the vacuum pass runs (tracked separately).
  setImmediate(() => {
    void ee.vectorStore?.enqueueSchemaColEmbedBatch({
      tenantId: user.tenantId,
      tableId: row.id,
      columnNames: fresh.map((c) => c.name),
    });
  });

  recordAudit({
    user, kind: "lake.table.schema." + parsed.data.action, target: row.id, req,
    meta: { name: row.name, ...parsed.data, ...(retypeResult ? { retypeResult } : {}) },
  });

  // Samples are values from the table: masked like its rows.
  return NextResponse.json({ ok: true, schema: redactSamples(fresh, viewer), ...(retypeResult ? { retypeResult } : {}) });
}
