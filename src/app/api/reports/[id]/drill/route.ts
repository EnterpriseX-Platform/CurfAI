import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReportWithProof } from "@/lib/reporting/runner";
import { exportViewer } from "@/lib/reporting/exportCaller";
import { visibleReport } from "@/lib/reporting/visibleReport";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { blockDrill } from "@/lib/reporting/drill";
import { localizeBlock } from "@/lib/reporting/localize";
import { LOCALES, type Locale } from "@/lib/i18n/dict";
import { ensureLimit } from "@/lib/rateLimit";

/**
 * POST /api/reports/:id/drill
 *
 * Body: { blockId, value, params }
 *
 * Looks up the named block on the report, reads its `config.drilldown`
 * (any drillable block — lib/reporting/drill.ts), and runs the drilldown
 * target query with `drilldown.filterParam` bound to `value` (a KPI's
 * drill has none: the rows behind the whole number). Returns rows +
 * columns so the viewer can render them in a slide-out panel. The target
 * query doesn't run when the report loads — only here.
 *
 * Existing filter-bar params from the URL ride along, so a user clicking
 * "Email" on a chart that's already filtered to "Last 30 days" gets the
 * intersection (the date filter still narrows the underlying rows).
 */

const Schema = z.object({
  blockId: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  params: z.record(z.unknown()).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const limited = ensureLimit("drill", `t:${user.tenantId}`, 60, 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const row = await prisma.report.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The caller's view: a block hidden from their roles is as missing as one
  // that doesn't exist, and the queries only hidden blocks read don't run.
  const viewer = await exportViewer(user);
  const report = visibleReport(ReportSchema.parse(JSON.parse(row.definition)), viewer);

  // Locate the block + its drilldown config.
  type DrillCfg = { queryId: string; filterParam?: string; title?: string; columns?: Array<{ key: string; label: string; type: string; format?: string }> };
  const found = report.pages.flatMap((p) => p.blocks).find((b) => b.id === parsed.data.blockId);
  if (!found) return NextResponse.json({ error: "Block not found" }, { status: 404 });
  // The panel's title in the reader's language (the block's i18n, e.g. "drilldown.title").
  const cookieLocale = req.cookies.get("rd_locale")?.value ?? "";
  const block = (LOCALES as readonly string[]).includes(cookieLocale) ? localizeBlock(found, cookieLocale as Locale) : found;
  const drill = blockDrill(report, { type: block.type, config: { drilldown: (block.config as { drilldown?: DrillCfg }).drilldown } });
  if (drill?.kind !== "rows") {
    return NextResponse.json({ error: "Block has no drilldown configured" }, { status: 400 });
  }
  const drilldown: DrillCfg = drill.drilldown;
  const blockTitle = (block.config as { title?: string; label?: string }).title ?? (block.config as { label?: string }).label ?? null;

  // Find the target dataSource on the report.
  const target = report.dataSources.find((d) => d.id === drilldown.queryId);
  if (!target) {
    return NextResponse.json(
      { error: `Drilldown target query "${drilldown.queryId}" not found on this report` },
      { status: 400 },
    );
  }

  // Build params: any existing filter-bar values, then override the drilldown
  // filterParam with the clicked value. Convert null -> empty string so the
  // SQL's `:filterParam = '' OR ...` style guards keep working.
  const merged: Record<string, unknown> = { ...(parsed.data.params ?? {}) };
  // Hydrate defaults for any unset declared parameters so SQL like
  // `:date_range` doesn't fail with "Missing parameter".
  for (const p of report.parameters) {
    if (!(p.name in merged) || merged[p.name] === undefined || merged[p.name] === null) {
      merged[p.name] = p.default ?? "";
    }
  }
  if (drilldown.filterParam) merged[drilldown.filterParam] = parsed.data.value ?? "";

  // Run a *narrowed* version of the report containing just the target query,
  // so we don't waste cycles on every other block's data source — and with
  // no blocks, so the runner doesn't take it for drill-only and skip it.
  const narrow = { ...report, pages: [], dataSources: [target] };

  try {
    // The rows go straight back to the caller, so they run as the caller:
    // a source their role can't see returns nothing, and sensitive lake
    // columns come back redacted, the same as on the chart they clicked.
    const { dataset } = await runReportWithProof({ report: narrow, params: merged, tenantId: row.tenantId, viewer });
    const rows = dataset[target.id] ?? [];
    const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];
    return NextResponse.json({
      title: drilldown.title || blockTitle || target.name,
      filterParam: drilldown.filterParam ?? null,
      filterValue: drilldown.filterParam ? parsed.data.value : null,
      rowCount: rows.length,
      columns,
      // The panel's own columns (headings in the reader's language, a type to format by), when the drill names them.
      columnDefs: drilldown.columns?.length ? drilldown.columns.map(({ key, label, type, format }) => ({ key, label, type, format })) : null,
      rows: rows.slice(0, 200), // cap so we don't ship a huge payload
      truncated: rows.length > 200,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Drill failed" }, { status: 500 });
  }
}
