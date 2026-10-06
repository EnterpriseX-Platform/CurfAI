/**
 * A report as one viewer may see it. A block's visibleToRoles used to hide
 * it only on screen: every surface still ran every query in
 * report.dataSources and handed the rows over. So the report data API, the
 * viewer page's RSC payload, public share / embed links and dashboards
 * carried the rows (and SQL) of the very blocks the author hid.
 *
 * visibleReport() drops the hidden blocks, then the queries only those
 * blocks needed, so a surface that runs and renders its result can't carry
 * either. A query goes only when a hidden block reads it and nothing that
 * stays does.
 */
import { filterBlocksForRoles, getUserRoles, type CurfSessionUser } from "@/lib/auth";
import { canBuild } from "@/lib/roles";
import type { RunViewer } from "@/lib/reporting/runner";
import { ReportSchema, type Block, type Report } from "@/lib/reporting/schema";
import { neededQueries } from "@/lib/reporting/queryRefs";

/**
 * The report with only the blocks this viewer may see (the same
 * filterBlocksForRoles() the viewer page has always used) and only the
 * queries that something left in the report still needs.
 *
 * No viewer is filtered as nobody: no roles, not an admin. That is how a
 * public link or a kiosk renders, and how a scheduled delivery's blocks
 * filter (its data still runs as the schedule's creator), so a scheduled
 * file carries the same blocks as the scheduled PDF.
 */
export function visibleReport(report: Report, viewer: Pick<RunViewer, "roles" | "isAdmin"> | undefined): Report {
  const hidden: Block[] = [];
  const pages = report.pages.map((page) => {
    const { visible } = filterBlocksForRoles(page.blocks, viewer?.roles ?? [], viewer?.isAdmin ?? false);
    const kept = new Set(visible);
    hidden.push(...page.blocks.filter((b) => !kept.has(b)));
    return { ...page, blocks: visible };
  });
  return dropQueriesOnlyUsedBy({ ...report, pages }, hidden);
}

/**
 * The stored definition as this caller may read it through the API.
 *
 * Someone who can edit the report (admin, developer) gets all of it: they
 * can change the gates anyway, and a filtered copy saved back through PUT
 * would delete the blocks it left out. Everyone else gets visibleReport(),
 * so a viewer or a viewer-role API key no longer reads the hidden blocks
 * and their queries' SQL. A definition that doesn't parse comes back null
 * for them rather than unfiltered.
 */
export async function readableDefinition(user: CurfSessionUser, raw: unknown): Promise<unknown> {
  if (canBuild(user.role)) return raw;
  const parsed = ReportSchema.safeParse(raw);
  if (!parsed.success) return null;
  return visibleReport(parsed.data, { isAdmin: false, roles: await getUserRoles() });
}

/**
 * `report` minus the queries that only the `removed` blocks needed.
 * `report` must already be without those blocks.
 *
 * A block or query reads a query through a field named queryId or ending in
 * QueryId, at any depth: config.queryId, a KPI's sparkQueryId, a map's
 * pinsQueryId, a drilldown's queryId, a join's queryId. Those are the only
 * references (text interpolates params and rows, never a query), and
 * visibleReport.test.ts fails if a field that names a query breaks the
 * pattern. Matching the id anywhere else would keep a hidden query whose id
 * is a plain word ("branches") that a visible block uses as a column name.
 *
 * A query no block reads at all is left alone: it isn't a hidden block's to
 * take away.
 */
export function dropQueriesOnlyUsedBy(report: Report, removed: Block[]): Report {
  if (removed.length === 0) return report;
  const forRemoved = neededQueries(report.dataSources, removed);
  if (forRemoved.size === 0) return report;
  const forRest = neededQueries(report.dataSources, { ...report, dataSources: [] });
  return { ...report, dataSources: report.dataSources.filter((q) => !forRemoved.has(q.id) || forRest.has(q.id)) };
}

/**
 * Ids of the blocks `report` has that `view` (its visibleReport()) doesn't.
 * For what's attached to a block by id rather than read from it — comments
 * on it are about what it shows. A block id that isn't in the report at all
 * (since deleted) isn't hidden.
 */
export function hiddenBlockIds(report: Report, view: Report): Set<string> {
  const shown = new Set(view.pages.flatMap((p) => p.blocks.map((b) => b.id)));
  return new Set(report.pages.flatMap((p) => p.blocks.map((b) => b.id)).filter((id) => !shown.has(id)));
}
