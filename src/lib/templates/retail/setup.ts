/**
 * Setting up the retail pack (pack.ts) in a workspace, and keeping it in
 * step with the data afterwards.
 *
 * Setup works the figures out first (refreshRetailMetrics), so the reports
 * are created against tables that exist, then applies the pack through
 * applyWorkspaceTemplate — quota checks, and anything already there
 * (by name) is left alone, so running it again only adds what's missing:
 * the stock report once a stock file has been imported, say.
 *
 * The branch picker on each report is a fixed list; after every import
 * syncRetailBranchOptions rewrites that one parameter's options from the
 * branches in the data, so a new branch shows up without re-running setup.
 * upgradeRetailReports then gives reports made by an earlier pack what the
 * pack adds now — drills, translations — where the shop hasn't changed
 * them (upgrade.ts). keepRetailReportsCurrent does both, after every import,
 * refresh and setup.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { reportWhere, type CurfSessionUser } from "@/lib/auth";
import { LOCALES, type Locale } from "@/lib/i18n/dict";
import { openLake } from "@/lib/lake/storage";
import { lakeTableExists } from "@/lib/lake/tables";
import { refreshRetailMetrics, retailCapabilities, type RetailRefresh } from "@/lib/lake/retailMetrics";
import { applyWorkspaceTemplate, type ApplySummary } from "../workspaces/apply";
import { ee } from "@/ee";
import { RETAIL_REPORTS, RETAIL_REPORT_NAMES, retailPack } from "./pack";
import { upgradeFromPack, type PackReport } from "./upgrade";

/** More than this and the picker isn't the way to choose — the report still filters by any value. */
const MAX_BRANCH_OPTIONS = 300;

export type RetailStatus = {
  hasSales: boolean;
  hasStock: boolean;
  reports: Array<{ id: string; name: string }>;
  /** How many reports the data supports now — more than `reports` means setup would add some. */
  expected: number;
};

export async function retailStatus(user: CurfSessionUser): Promise<RetailStatus> {
  const reports = await prisma.report.findMany({
    where: { ...reportWhere(user), name: { in: RETAIL_REPORT_NAMES } },
    select: { id: true, name: true },
  });
  const hasSales = lakeTableExists(user.tenantId, "sales_lines");
  const hasStock = lakeTableExists(user.tenantId, "inventory");
  const expected = retailPack({
    locale: "en", hasSales, hasStock, branches: [], ...(hasSales ? retailCapabilities(user.tenantId) : {}),
  }).reports.length;
  return {
    hasSales,
    hasStock,
    // In the pack's own order: overview, insights, stock, plan, basket, menu.
    reports: RETAIL_REPORT_NAMES.flatMap((n) => reports.filter((r) => r.name === n)),
    expected,
  };
}

/**
 * Every branch in the sales and stock data, sorted. Read from the standard
 * tables, whose (branch, date) index answers this without touching a row —
 * stock_status can be a million rows, and this runs on the main thread.
 */
export function retailBranches(tenantId: string): string[] {
  const parts = ["sales_lines", "inventory"]
    .filter((t) => lakeTableExists(tenantId, t))
    .map((t) => `SELECT DISTINCT branch FROM "${t}" WHERE branch IS NOT NULL AND branch <> ''`);
  if (parts.length === 0) return [];
  const rows = openLake(tenantId)
    .prepare(`SELECT branch FROM (${parts.join(" UNION ")}) ORDER BY branch LIMIT ${MAX_BRANCH_OPTIONS}`)
    .all() as Array<{ branch: string }>;
  // Branch codes read in number order (2 before 10), names alphabetically.
  return rows.map((r) => String(r.branch)).sort((a, b) => a.localeCompare(b, "th", { numeric: true }));
}

export async function setupRetailPack(
  user: CurfSessionUser,
  opts: { locale: Locale; req?: NextRequest },
): Promise<{ status: RetailStatus; summary: ApplySummary; metrics: RetailRefresh; pinned: number }> {
  const metrics = await refreshRetailMetrics(user, opts.req);
  const hasSales = lakeTableExists(user.tenantId, "sales_lines");
  const hasStock = lakeTableExists(user.tenantId, "inventory");
  const before = new Set((await retailStatus(user)).reports.map((r) => r.id));
  const summary = await applyWorkspaceTemplate(
    user,
    retailPack({
      locale: opts.locale, hasSales, hasStock, branches: retailBranches(user.tenantId),
      ...(hasSales ? retailCapabilities(user.tenantId) : {}),
    }),
  );
  // Reports that were already there (skipped by name) still get today's branches, and the pack's newer drills and translations.
  await keepRetailReportsCurrent(user);
  const status = await retailStatus(user);
  const pinned = await pinRetailKpis(user, status.reports.filter((r) => !before.has(r.id)));
  return { status, summary, metrics, pinned };
}

/**
 * The numbers an owner looks at every morning, pinned to the Home of
 * whoever set the pack up — Home is also what the LINE morning brief sends
 * (lib/line/brief.ts). Only for reports this setup created, so a pin
 * someone took off isn't put back by setting up again; never past MAX_PINS.
 */
const MORNING_KPIS: Record<string, string[]> = {
  [RETAIL_REPORTS.overview]: ["k_day", "k_rev"],
  [RETAIL_REPORTS.stock]: ["k_order", "k_out"],
};

async function pinRetailKpis(user: CurfSessionUser, created: Array<{ id: string; name: string }>): Promise<number> {
  const wanted = created.flatMap((r) => (MORNING_KPIS[r.name] ?? []).map((blockId) => ({ reportId: r.id, blockId })));
  if (wanted.length === 0) return 0;
  // Home is paid (ee.home); Community has no Home to pin to.
  return (await ee.home?.addPins(user.id, user.tenantId, wanted)) ?? 0;
}

/**
 * Rewrite the branch picker on the retail reports from the data. Touches
 * only that one parameter's options; everything else on a report someone
 * has since edited stays as they left it. Best-effort — a report whose
 * definition doesn't parse is skipped.
 */
export async function syncRetailBranchOptions(user: CurfSessionUser): Promise<number> {
  const reports = await prisma.report.findMany({
    where: { ...reportWhere(user), name: { in: RETAIL_REPORT_NAMES } },
    select: { id: true, definition: true },
  });
  if (reports.length === 0) return 0;
  const branches = retailBranches(user.tenantId);
  let updated = 0;
  for (const r of reports) {
    let def: any;
    try { def = JSON.parse(r.definition); } catch { continue; }
    const param = Array.isArray(def?.parameters) ? def.parameters.find((p: any) => p?.name === "branch" && p?.type === "select") : null;
    if (!param || !Array.isArray(param.options) || param.options.length === 0) continue;
    // The first option is "all branches", in the language the report was set up in.
    const options = [param.options[0], ...branches.map((b) => ({ value: b, label: b }))];
    if (JSON.stringify(options) === JSON.stringify(param.options)) continue;
    param.options = options;
    await prisma.report.updateMany({ where: { ...reportWhere(user), id: r.id }, data: { definition: JSON.stringify(def) } });
    updated += 1;
  }
  return updated;
}

/** After an import, a refresh or setup: the branch picker from the data, and what a newer pack adds. */
export async function keepRetailReportsCurrent(user: CurfSessionUser): Promise<void> {
  await syncRetailBranchOptions(user);
  await upgradeRetailReports(user);
}

/**
 * Give each retail report what the current pack adds — new drills, and
 * translations of words still as the pack wrote them — without changing
 * anything the shop edited (upgrade.ts). The report's own language is the
 * build whose words it shares most; one sharing none is left alone.
 * Best-effort, like syncRetailBranchOptions.
 */
export async function upgradeRetailReports(user: CurfSessionUser): Promise<number> {
  const reports = await prisma.report.findMany({
    where: { ...reportWhere(user), name: { in: RETAIL_REPORT_NAMES } },
    select: { id: true, name: true, definition: true },
  });
  if (reports.length === 0) return 0;
  const hasSales = lakeTableExists(user.tenantId, "sales_lines");
  const opts = {
    hasSales, hasStock: lakeTableExists(user.tenantId, "inventory"), branches: retailBranches(user.tenantId),
    ...(hasSales ? retailCapabilities(user.tenantId) : {}),
  };
  const packs = LOCALES.map((locale) => retailPack({ locale, ...opts }));
  let updated = 0;
  for (const r of reports) {
    let def: PackReport;
    try { def = JSON.parse(r.definition); } catch { continue; }
    const lake = def?.dataSources?.[0]?.dataSourceId;
    if (typeof lake !== "string" || !Array.isArray(def.pages)) continue;
    let best: PackReport | null = null;
    let bestScore = 0;
    for (const pack of packs) {
      const spec = pack.reports.find((x) => x.name === r.name);
      if (!spec) continue;
      const fresh = spec.buildDefinition(lake) as unknown as PackReport;
      const score = sharedWords(def, fresh);
      if (score > bestScore) { best = fresh; bestScore = score; }
    }
    const next = best && upgradeFromPack(def, best);
    if (!next) continue;
    await prisma.report.updateMany({ where: { ...reportWhere(user), id: r.id }, data: { definition: JSON.stringify(next) } });
    updated += 1;
  }
  return updated;
}

/** How many of a report's blocks read the same title, text or label as `fresh`'s block of that id. */
function sharedWords(def: PackReport, fresh: PackReport): number {
  const theirs = new Map(fresh.pages.flatMap((p) => p.blocks).map((b) => [b.id, b.config ?? {}]));
  let n = 0;
  for (const b of def.pages.flatMap((p) => p.blocks ?? [])) {
    const t = theirs.get(b.id);
    const c = b.config ?? {};
    if (t && (["title", "text", "label"] as const).some((k) => typeof c[k] === "string" && c[k] === t[k])) n += 1;
  }
  return n;
}
