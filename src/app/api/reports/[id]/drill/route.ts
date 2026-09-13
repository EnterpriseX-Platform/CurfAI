import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReportWithProof } from "@/lib/reporting/runner";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { ensureLimit } from "@/lib/rateLimit";

/**
 * POST /api/reports/:id/drill
 *
 * Body: { blockId, value, params }
 *
 * Looks up the named block on the report, reads its `config.drilldown`
 * config (currently only ChartBlock supports it), and runs the drilldown
 * target query with `drilldown.filterParam` bound to `value`. Returns
 * rows + columns so the viewer can render them in a slide-out panel.
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

  const report = ReportSchema.parse(JSON.parse(row.definition));

  // Locate the block + its drilldown config.
  type DrillCfg = { queryId: string; filterParam: string; title?: string };
  let drilldown: DrillCfg | null = null;
  let blockTitle: string | null = null;
  outer: for (const page of report.pages) {
    for (const block of page.blocks) {
      if (block.id !== parsed.data.blockId) continue;
      // Drill-through is supported on any block type whose config carries a
      // `drilldown` clause — currently chart and map. The check used to be
      // hardcoded to "chart" only, which broke the map's click-to-drill flow.
      if (block.type !== "chart" && block.type !== "map") {
        return NextResponse.json({ error: `Drill-through is not supported on ${block.type} blocks` }, { status: 400 });
      }
      const cfg = (block as any).config as { title?: string; drilldown?: DrillCfg };
      if (!cfg.drilldown) {
        return NextResponse.json({ error: "Block has no drilldown configured" }, { status: 400 });
      }
      drilldown = cfg.drilldown;
      blockTitle = cfg.title ?? null;
      break outer;
    }
  }
  if (!drilldown) return NextResponse.json({ error: "Block not found" }, { status: 404 });

  // Find the target dataSource on the report. (Local copy keeps TS happy
  // through the closure — `drilldown` itself is narrowed to non-null above.)
  const dl: DrillCfg = drilldown;
  const target = report.dataSources.find((d) => d.id === dl.queryId);
  if (!target) {
    return NextResponse.json(
      { error: `Drilldown target query "${dl.queryId}" not found on this report` },
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
  merged[drilldown.filterParam] = parsed.data.value ?? "";

  // Run a *narrowed* version of the report containing just the target query,
  // so we don't waste cycles on every other block's data source.
  const narrow = { ...report, dataSources: [target] };

  try {
    const { dataset } = await runReportWithProof({ report: narrow, params: merged });
    const rows = dataset[target.id] ?? [];
    const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];
    return NextResponse.json({
      title: blockTitle ?? drilldown.title ?? target.name,
      filterParam: drilldown.filterParam,
      filterValue: parsed.data.value,
      rowCount: rows.length,
      columns,
      rows: rows.slice(0, 200), // cap so we don't ship a huge payload
      truncated: rows.length > 200,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Drill failed" }, { status: 500 });
  }
}
