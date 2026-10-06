/**
 * A report definition may only name its own workspace's data sources.
 *
 * The runner already refuses to read another workspace's source
 * (RunContext.tenantId). This stops one being written in the first place:
 * the designer's save, an import, a restored version or a kept app view used
 * to store whatever source ids the body carried, where they sat until someone
 * — or a cron tick — ran the report.
 *
 * Every id counts: each query's dataSourceId and each ATTACHed source's.
 * Placeholder ids (a template or import not wired to a connection yet) name
 * no source and are allowed.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isPlaceholder } from "@/lib/reporting/sanitizeTemplate";
import type { Report } from "@/lib/reporting/schema";

/** The source ids `report` names that aren't `tenantId`'s. */
export async function foreignSourceIds(tenantId: string, report: Pick<Report, "dataSources">): Promise<string[]> {
  const named = new Set<string>();
  for (const q of report.dataSources ?? []) {
    if (q.dataSourceId && !isPlaceholder(q.dataSourceId)) named.add(q.dataSourceId);
    for (const a of q.attaches ?? []) if (!isPlaceholder(a.dataSourceId)) named.add(a.dataSourceId);
  }
  if (named.size === 0) return [];
  const own = await prisma.dataSource.findMany({ where: { tenantId, id: { in: [...named] } }, select: { id: true } });
  const ownIds = new Set(own.map((d) => d.id));
  return [...named].filter((id) => !ownIds.has(id));
}

/**
 * The 400 a write answers when `report` names a source outside `tenantId`,
 * or null. Used as `const block = await foreignSourcesBlock(...); if (block)
 * return block;`, like featureGate(). A source that doesn't exist at all
 * reads the same as another workspace's, so ids can't be probed.
 */
export async function foreignSourcesBlock(tenantId: string, report: Pick<Report, "dataSources">): Promise<NextResponse | null> {
  const foreign = await foreignSourceIds(tenantId, report);
  if (foreign.length === 0) return null;
  return NextResponse.json(
    { error: "This report uses data sources that aren't in this workspace.", dataSourceIds: foreign },
    { status: 400 },
  );
}
