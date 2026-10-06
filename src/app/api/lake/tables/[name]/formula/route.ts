/**
 * /api/lake/tables/[name]/formula — the formula editor's helpers. Adding or
 * changing the column itself is the schema route's addFormula / setFormula.
 *
 * Body (discriminated by `action`):
 *   { action: "preview", formula, name? }  — what it gives on the first rows,
 *       and how many of a sample it leaves blank (lib/lake/formula/preview.ts).
 *       `name` is the formula column being changed, for an edit.
 *   { action: "suggest", description }     — "Describe it": the workspace's
 *       model writes the formula (lib/lake/formula/suggest.ts). Metered.
 *
 * Anyone who can read the table and build may use it. Preview values are
 * masked as the table page masks them: each column by its own tags, the
 * result by the tags the new column would carry (withFormulaGovernance).
 * A formula that doesn't check out is a 400 with `at`, `code`, and `key` +
 * `params` for showing it in the reader's language (formula/messages.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { lakeTableFor } from "@/lib/lake/tableAccess";
import { applyRedaction, readsSensitiveData } from "@/lib/lake/redaction";
import { getTable } from "@/lib/lake/tables";
import { mergeGovernanceMetadata, parseSchemaJson, withFormulaGovernance } from "@/lib/lake/schemaGovernance";
import { FormulaError, MAX_FORMULA_LENGTH } from "@/lib/lake/formula/parse";
import { previewFormula } from "@/lib/lake/formula/preview";
import { suggestFormula } from "@/lib/lake/formula/suggest";
import { requireAiCreditsFor } from "@/lib/llm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), formula: z.string().min(1).max(MAX_FORMULA_LENGTH), name: z.string().min(1).max(60).optional() }),
  z.object({ action: z.literal("suggest"), description: z.string().min(1).max(500) }),
]);

export async function POST(req: NextRequest, { params }: { params: { name: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // A table this viewer can't read answers as one that isn't there.
  const access = await lakeTableFor(user, decodeURIComponent(params.name), "build");
  if (access instanceof NextResponse) return access;
  const { row, viewer } = access;

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  if (parsed.data.action === "suggest") {
    const credits = await requireAiCreditsFor(user.tenantId);
    if (credits) return credits;
    const columns = (await getTable(user.tenantId, row.name))?.columns ?? [];
    const suggestion = await suggestFormula({
      tenantId: user.tenantId,
      userId: user.viaApiKey ? null : user.id,
      description: parsed.data.description,
      signal: req.signal,
      columns,
    });
    return NextResponse.json(suggestion);
  }

  let preview;
  try {
    preview = await previewFormula({ tenantId: user.tenantId, tableName: row.name, formula: parsed.data.formula, columnName: parsed.data.name });
  } catch (e: any) {
    if (e instanceof FormulaError) return NextResponse.json({ error: e.message, ...(e.at >= 0 ? { at: e.at } : {}), code: e.code, key: e.key, params: e.params }, { status: 400 });
    // The engine's own words stay in the server log: they can quote a value (audit 2026-09-30, S9).
    console.warn(`[formula preview] ${row.name}:`, String(e?.message ?? e).slice(0, 300));
    return NextResponse.json({ error: "Couldn't preview the formula.", code: "preview_failed" }, { status: 400 });
  }

  const schema = withFormulaGovernance([
    ...mergeGovernanceMetadata(parseSchemaJson(row.schemaJson), preview.columns),
    { name: preview.valueKey, type: preview.type, formula: parsed.data.formula },
  ]).filter((c) => c.name === preview.valueKey || preview.uses.includes(c.name));
  const rows = applyRedaction(preview.rows, schema, viewer);
  const sens = readsSensitiveData(viewer, schema);
  if (sens.any) {
    recordAudit({ user, kind: "lake.table.read.sensitive", target: row.id, req, meta: { name: row.name, redactedColumns: sens.redactedColumns } });
  }

  return NextResponse.json({
    type: preview.type,
    uses: preview.uses,
    valueKey: preview.valueKey,
    rows,
    sampled: preview.sampled,
    blank: preview.blank,
  });
}
