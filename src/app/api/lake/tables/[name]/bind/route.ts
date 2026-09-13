/**
 * POST /api/lake/tables/:name/bind — replace a synthetic table's rows with
 * the customer's real data, in place (E2).
 *
 * This is the Discovery → Pilot moment. Master Builder provisions every
 * generated app on synthetic rows; binding swaps the rows underneath the
 * same table name, so every report, watcher and view that already points at
 * it keeps working and simply starts showing real numbers. Nothing is
 * re-pointed, so nothing can be left pointing at the old data.
 *
 * Three things this refuses to do, because each would be worse than not
 * binding at all:
 *
 *   1. Bind a shape that doesn't fit. If the incoming rows are missing
 *      columns the existing reports read, those reports would silently
 *      render blanks. The mismatch is reported instead, naming the columns.
 *   2. Bind onto a table that was never synthetic. Overwriting a table the
 *      customer already loaded is data loss, not a pilot step.
 *   3. Bind nothing. An empty array would wipe the table and leave every
 *      view empty with no way back.
 *
 * On success the table's provenance flips from synthetic to real, and any
 * app whose views read this table has its dataMode badge advanced — so the
 * "SIMULATED DATA" pill stops claiming something that is no longer true.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdminOrEditor } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { createOrReplaceTable } from "@/lib/lake/tables";
import { checkWriteAllowed } from "@/lib/lake/quota";
import { ee } from "@/ee";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  /** The real rows. Objects keyed by column name. */
  rows: z.array(z.record(z.any())).min(1).max(50_000),
  /** Where they came from, recorded on the table for provenance. */
  sourceLabel: z.string().max(200).optional(),
  /**
   * Allow columns the synthetic table didn't have. Extra columns are
   * additive and safe; MISSING ones are the dangerous direction and are
   * never waved through by this flag.
   */
  allowNewColumns: z.boolean().default(true),
});

export async function POST(req: NextRequest, { params }: { params: { name: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;

  const table = await prisma.lakeTable.findFirst({
    where: { tenantId: user.tenantId, name: params.name },
  });
  if (!table) return NextResponse.json({ error: "Lake table not found" }, { status: 404 });

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  const { rows, sourceLabel, allowNewColumns } = parsed.data;

  // (2) Only a synthetic table may be bound over. Master Builder stamps the
  // build id into sourceConfigJson; a table without that marker was loaded
  // by the customer, and replacing it here would be silent data loss.
  let sourceConfig: any = {};
  try { sourceConfig = JSON.parse(table.sourceConfigJson ?? "{}"); } catch { /* treat as empty */ }
  if (!sourceConfig?.buildId && sourceConfig?.synthetic !== true) {
    return NextResponse.json(
      {
        error:
          "This table wasn't generated with synthetic data, so binding would overwrite real rows. " +
          "Load it through Curf Tables instead.",
      },
      { status: 409 },
    );
  }

  // (1) Shape check. Every column the current schema declares must be
  // present in the incoming rows, or reports reading it start rendering
  // blanks with no error anywhere.
  let existingColumns: Array<{ name: string }> = [];
  try { existingColumns = JSON.parse(table.schemaJson ?? "[]"); } catch { /* treat as unknown */ }
  const incoming = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) incoming.add(k);
  const missing = existingColumns.map((c) => c.name).filter((n) => !incoming.has(n));
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: "The incoming data is missing columns this table's reports already read.",
        missing,
        hint: "Rename or add these columns in the source file, or update the reports first.",
      },
      { status: 422 },
    );
  }
  const added = Array.from(incoming).filter((n) => !existingColumns.some((c) => c.name === n));
  if (added.length > 0 && !allowNewColumns) {
    return NextResponse.json({ error: "The incoming data has columns this table doesn't have.", added }, { status: 422 });
  }

  // Same quota gate every other lake write goes through — a bind is a write.
  const quotaError = await checkWriteAllowed({
    tenantId: user.tenantId,
    estimatedBytes: JSON.stringify(rows).length,
    newTable: false,
  });
  if (quotaError) return NextResponse.json({ error: quotaError }, { status: 402 });

  let result;
  try {
    result = createOrReplaceTable({
      tenantId: user.tenantId,
      tableName: table.name,
      rows,
      sourceKind: "upload",
      sourceConfig: {
        ...sourceConfig,
        synthetic: false,
        boundAt: new Date().toISOString(),
        boundBy: user.email,
        sourceLabel: sourceLabel ?? "bind",
        // Kept so the table's history stays legible after the swap.
        previousBuildId: sourceConfig?.buildId ?? null,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: `Bind failed: ${e?.message ?? String(e)}` }, { status: 500 });
  }

  await prisma.lakeTable.update({
    where: { id: table.id },
    data: {
      sourceKind: "upload",
      schemaJson: JSON.stringify(result.columns),
      rowCount: result.rowCount,
      sourceConfigJson: JSON.stringify({
        ...sourceConfig,
        synthetic: false,
        boundAt: new Date().toISOString(),
        boundBy: user.email,
        sourceLabel: sourceLabel ?? "bind",
        previousBuildId: sourceConfig?.buildId ?? null,
      }),
    },
  });

  // Advance the badge on every app that reads this table, so the app bar
  // stops saying SIMULATED DATA about rows that are now real. Apps still
  // running on other synthetic tables stay at "pilot" rather than "real".
  const advanced = ee.apps ? await ee.apps.advanceAppDataModes(user.tenantId, table.name) : [];

  recordAudit({
    user, kind: "lake.table.bind", target: table.id, req,
    meta: { table: table.name, rows: result.rowCount, addedColumns: added, appsAdvanced: advanced },
  });

  return NextResponse.json({
    ok: true,
    table: table.name,
    rowCount: result.rowCount,
    addedColumns: added,
    appsAdvanced: advanced,
  });
}
