import Link from "next/link";
import { redirect } from "next/navigation";
import { FileText, Plus, Database, Upload } from "lucide-react";
import { cookies } from "next/headers";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { CatalogSearch } from "./CatalogSearch";
import { ReportCard, type ReportCardData, type ReportThumb } from "./ReportCard";
import { GenerateReportButton } from "./GenerateReportButton";
import { SuggestedTemplates } from "./SuggestedTemplates";
import { computeKpiValue, kpiDelta, pickKpiCompare } from "@/lib/reporting/kpi";
import { formatMetricCompact } from "@/lib/reporting/format";
import { canBuild } from "@/lib/roles";

/**
 * A card's thumbnail is the report's own last verified run, not a picture of
 * it: the first two KPI blocks' values (and deltas) plus a short series
 * from the first sparkline or chart, read from the ReportRun snapshot the
 * viewer already records. Nothing is executed on the list page.
 */
function buildThumb(definition: string, datasetJson: string | null | undefined, currency: string): { thumb: ReportThumb; blocks: number } {
  let def: any = null;
  try { def = JSON.parse(definition); } catch { return { thumb: { kpis: [], bars: [] }, blocks: 0 }; }
  const blocks: any[] = (def?.pages ?? []).flatMap((p: any) => p?.blocks ?? []);
  let dataset: Record<string, Array<Record<string, unknown>>> = {};
  if (datasetJson && datasetJson.length < 1_500_000) {
    try { dataset = JSON.parse(datasetJson); } catch { dataset = {}; }
  }
  const kpis: ReportThumb["kpis"] = [];
  let bars: number[] = [];
  for (const b of blocks) {
    if (b?.type !== "kpi" || kpis.length >= 2) continue;
    const cfg = b.config ?? {};
    const rows = Array.isArray(dataset[cfg.queryId]) ? dataset[cfg.queryId] : [];
    const value = computeKpiValue({ valueField: cfg.valueField, aggregate: cfg.aggregate }, rows);
    if (!Number.isFinite(value)) continue;
    const delta = kpiDelta(value, pickKpiCompare(rows, cfg.compareField));
    const fmt = cfg.format === "currency" ? "currency" : cfg.format === "percent" ? "percent" : "number";
    const good = delta == null ? null : (delta >= 0) === ((cfg.sparkPositive ?? "up") === "up");
    kpis.push({
      label: String(cfg.label ?? "Metric"),
      value: (cfg.format === "percent" ? formatMetricCompact(value, "percent", currency) : formatMetricCompact(value, fmt, currency)) + (cfg.suffix ? ` ${cfg.suffix}` : ""),
      delta: delta == null ? null : `${delta >= 0 ? "▲" : "▼"} ${(Math.abs(delta) * 100).toFixed(1)}%`,
      good,
    });
    if (bars.length === 0 && cfg.sparkQueryId && cfg.sparkValueField) {
      bars = (dataset[cfg.sparkQueryId] ?? []).map((r) => Number(r[cfg.sparkValueField])).filter((n) => Number.isFinite(n)).slice(-7);
    }
  }
  if (bars.length === 0) {
    const chart = blocks.find((b) => b?.type === "chart" && b.config?.queryId && Array.isArray(b.config?.yFields) && b.config.yFields[0]);
    if (chart) {
      bars = (dataset[chart.config.queryId] ?? []).map((r) => Number(r[chart.config.yFields[0]])).filter((n) => Number.isFinite(n)).slice(0, 7);
    }
  }
  return { thumb: { kpis, bars }, blocks: blocks.length };
}

function initialsOf(name: string | null | undefined, email: string | null | undefined): string {
  const src = (name ?? email ?? "?").trim();
  return src.split(/[\s@._-]+/).filter(Boolean).map((s) => s[0]).slice(0, 2).join("").toUpperCase() || "?";
}

export const dynamic = "force-dynamic";

function readLocale(c: ReturnType<typeof cookies>): Locale {
  const v = c.get("rd_locale")?.value;
  return v && (LOCALES as readonly string[]).includes(v) ? (v as Locale) : "en";
}

function timeAgo(d: Date, locale: Locale): string {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return t(locale, "time.justNow");
  const m = Math.floor(s / 60); if (m < 60) return t(locale, "time.minutesAgo").replace("{n}", String(m));
  const h = Math.floor(m / 60); if (h < 24) return t(locale, "time.hoursAgo").replace("{n}", String(h));
  const days = Math.floor(h / 24);
  if (days < 30) return t(locale, "time.daysAgo").replace("{n}", String(days));
  const months = Math.floor(days / 30);
  return t(locale, "time.monthsAgo").replace("{n}", String(months));
}

export default async function ReportsCatalog({ searchParams }: { searchParams: { q?: string; category?: string; filter?: string } }) {
  const session = await getSession();
  const user = (session?.user as any) ?? null;
  if (!session) redirect("/login?callbackUrl=/reports");
  const role = (session.user as any)?.role ?? "viewer";
  const isAdmin = role === "admin";
  // Viewers consume reports; only editors and admins see create affordances.
  const canCreate = canBuild(role);
  
  const c = cookies();
  const locale = readLocale(c);

  const q = (searchParams.q ?? "").trim().toLowerCase();
  const category = searchParams.category ?? null;
  const filter = searchParams.filter === "mine" || searchParams.filter === "scheduled" ? searchParams.filter : null;

  const [reports, tenantRow] = await Promise.all([
    prisma.report.findMany({
      where: { tenantId: user.tenantId }, orderBy: { updatedAt: "desc" },
      include: {
        createdBy: { select: { name: true, email: true } },
        // Latest snapshot only, and only the columns the thumbnail reads —
        // provenance JSON is left out on purpose.
        runs: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, status: true, dataset: true } },
        _count: { select: { schedules: true } },
      },
    }),
    prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { currency: true } as any }),
  ]);
  const currency = ((tenantRow as any)?.currency as string | null) ?? "USD";

  const filtered = reports.filter((r) => {
    if (category && r.category !== category) return false;
    if (filter === "mine" && r.createdById !== user.id) return false;
    if (filter === "scheduled" && (r._count?.schedules ?? 0) === 0) return false;
    const hay = (r.name + " " + (r.description ?? "") + " " + (r.category ?? "")).toLowerCase();
    if (q && !hay.includes(q)) return false;
    return true;
  });

  const cards: ReportCardData[] = filtered.map((r) => {
    const run = r.runs[0];
    const { thumb, blocks } = buildThumb(r.definition, run?.dataset, currency);
    const ageMs = run ? Date.now() - new Date(run.createdAt).getTime() : Infinity;
    const freshness: ReportCardData["freshness"] = !run ? "none" : run.status === "failed" ? "crit" : ageMs > 24 * 3600 * 1000 ? "warn" : "ok";
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
      updatedAgo: timeAgo(r.updatedAt, locale),
      version: r.version,
      ownerInitials: initialsOf(r.createdBy?.name, r.createdBy?.email),
      ownerName: r.createdBy?.name ?? r.createdBy?.email ?? "",
      lastRun: run ? timeAgo(run.createdAt, locale) : null,
      freshness,
      schedules: r._count?.schedules ?? 0,
      blocks,
      thumb,
      labels: {
        lastRun: t(locale, "reports.lastRun"),
        neverRun: t(locale, "reports.neverRun"),
        blocks: t(locale, "reports.blocks"),
        scheduled: t(locale, "reports.schedules"),
        empty: t(locale, "reports.thumbEmpty"),
      },
    };
  });

  const categories = Array.from(new Set(reports.map((r) => r.category).filter(Boolean) as string[]));

  return (
    <AppShell
      breadcrumbs={[{ label: t(locale, "nav.reports") }]}
      actions={
        canCreate ? (
          <div className="flex items-center gap-2">
            <GenerateReportButton />
            {/* Hidden on the true first-run empty state (0 reports) — the
                "Blank canvas" card below already offers this exact action
                (same POST /api/reports), and having both on screen at once
                left a brand-new user staring at 4 near-identical "start"
                buttons with no idea which to pick. Reappears once a report
                exists, where it's the normal "add another" affordance. */}
            {reports.length > 0 && (
              <form action="/api/reports" method="POST">
                <Button type="submit" size="sm" variant="outline">
                  <Plus className="mr-1.5 h-4 w-4" /> {t(locale, "action.newReport")}
                </Button>
              </form>
            )}
          </div>
        ) : null
      }
    >
      <div className="mx-auto max-w-[1264px] px-8 pb-12 pt-7">
        <PageHeader
          title={t(locale, "nav.reports")}
          description={t(locale, "reports.count")
            .replace("{filtered}", String(filtered.length))
            .replace("{total}", String(reports.length))
            .replace("{plural}", reports.length === 1 ? "" : "s")}
        />

        <div className="mb-5 flex flex-wrap items-center gap-3">
          <CatalogSearch initial={q} />
          <div className="flex flex-wrap items-center gap-1.5">
            <CategoryChip label={t(locale, "reports.category.all")} href="/reports" active={category == null && filter == null} />
            <CategoryChip label={t(locale, "reports.filter.mine")} href="/reports?filter=mine" active={filter === "mine"} />
            <CategoryChip label={t(locale, "reports.filter.scheduled")} href="/reports?filter=scheduled" active={filter === "scheduled"} />
            {categories.map((cat) => (
              <CategoryChip key={cat} label={cat} href={"/reports?category=" + encodeURIComponent(cat)} active={category === cat} />
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <>
            <EmptyState hasReports={reports.length > 0} canCreate={canCreate} locale={locale} />
            {/* Marketplace nudge — only when the user truly has zero
                reports (i.e., this is the empty-state path, not a
                "filter returned 0" path). canCreate too — viewers
                can't import. */}
            {reports.length === 0 && canCreate && (
              <SuggestedTemplates tenantId={user.tenantId} />
            )}
          </>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {cards.map((r) => (
              <ReportCard key={r.id} isAdmin={isAdmin} r={r} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}

// Filter chip: the active one is drawn in ink (border + text), not tinted —
// the accent is reserved for things you can act on.
function CategoryChip({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={"inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium transition-colors " + (active ? "border-foreground text-foreground" : "border-border bg-card text-muted-foreground hover:border-input hover:text-foreground")}
    >
      {label}
    </Link>
  );
}

function EmptyState({ hasReports, canCreate, locale }: { hasReports: boolean; canCreate: boolean; locale: Locale }) {
  // "No matches" path stays the same — user is filtering an existing
  // catalog and we just need to tell them to broaden the search.
  if (hasReports) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border p-16 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <FileText className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="text-base font-semibold">{t(locale, "reports.noMatches.title")}</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {t(locale, "reports.noMatches.desc")}
        </p>
      </div>
    );
  }

  // No reports + viewer-role: fall back to the original copy.
  if (!canCreate) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border p-16 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <FileText className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="text-base font-semibold">{t(locale, "reports.empty")}</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {t(locale, "reports.empty.viewer.desc")}
        </p>
      </div>
    );
  }

  // No reports + can create: present TWO paths. Drop-a-CSV is the
  // recommended first-session path (no warehouse, no connection wiring),
  // and a blank-canvas option for users who want to design from scratch.
  // This is the "first session" goal from ROADMAP-DATA-LAYER.md.
  return (
    <div className="rounded-xl border border-dashed border-border p-10">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <FileText className="h-5 w-5" />
        </div>
        <h3 className="text-base font-semibold">{t(locale, "reports.empty.land")}</h3>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          {t(locale, "reports.empty.land.desc")}
        </p>
      </div>

      <div className="mx-auto grid max-w-2xl gap-3 sm:grid-cols-2">
        <Link
          href="/tables"
          className="group flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-4 transition-colors hover:bg-primary/10"
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-primary">
            <Upload className="h-4 w-4" /> {t(locale, "reports.empty.dropCsv.title")}
          </span>
          <span className="text-xs text-muted-foreground">
            {t(locale, "reports.empty.dropCsv.desc")}
          </span>
        </Link>
        <form action="/api/reports" method="POST" className="contents">
          <button
            type="submit"
            className="group flex flex-col gap-2 rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-foreground/30 hover:bg-muted"
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Plus className="h-4 w-4" /> {t(locale, "reports.empty.blankCanvas.title")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t(locale, "reports.empty.blankCanvas.desc")}
            </span>
          </button>
        </form>
      </div>

      <div className="mx-auto mt-6 max-w-2xl text-center text-[11px] text-muted-foreground">
        {t(locale, "reports.empty.haveDb")} <Link href="/data-sources" className="text-primary hover:underline"><Database className="inline h-3 w-3" /> {t(locale, "nav.connections")}</Link> {t(locale, "reports.empty.haveDb.suffix")}
      </div>
    </div>
  );
}
