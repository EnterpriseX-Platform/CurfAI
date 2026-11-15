import Link from "next/link";
import { redirect } from "next/navigation";
import { FileText, Plus, Database, Upload, Shapes } from "lucide-react";
import { cookies } from "next/headers";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { prisma } from "@/lib/db";
import { getSession, getUserRoles, reportWhere, tenantWhere } from "@/lib/auth";
import { canSeeDataSource, readVisibility } from "@/lib/datasourceAcl";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { CatalogSearch } from "./CatalogSearch";
import { CategoryMenu } from "./CategoryMenu";
import type { ReportCardData } from "./ReportCard";
import { ReportsCatalogView } from "./ReportsCatalogView";
import { GenerateReportButton } from "./GenerateReportButton";
import { NewMenu } from "./NewMenu";
import { SuggestedTemplates } from "./SuggestedTemplates";
import { reportThumbnail, dashboardThumbnail } from "@/components/lists/thumbnailModel";
import { canBuild } from "@/lib/roles";

function initialsOf(name: string | null | undefined, email: string | null | undefined): string {
  const src = (name ?? email ?? "?").trim();
  return src.split(/[\s@._-]+/).filter(Boolean).map((s) => s[0]).slice(0, 2).join("").toUpperCase() || "?";
}

export const dynamic = "force-dynamic";

function readLocale(c: Awaited<Awaited<ReturnType<typeof cookies>>>): Locale {
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

type SearchParams = { q?: string; category?: string; filter?: string; type?: string };

/** One row of the catalog before filtering: a report or a dashboard, with what the tabs and search need. */
type CatalogItem = {
  kind: "report" | "dashboard";
  at: Date;
  createdById: string;
  published: boolean;
  category: string | null;
  text: string;
  card: ReportCardData;
};

export default async function ReportsCatalog(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await props.searchParams;
  const session = await getSession();
  const user = (session?.user as any) ?? null;
  if (!session) redirect("/login?callbackUrl=/reports");
  const role = (session.user as any)?.role ?? "viewer";
  const isAdmin = role === "admin";
  // Viewers consume reports; only editors and admins see create affordances.
  const canCreate = canBuild(role);

  const c = await cookies();
  const locale = readLocale(c);

  const q = (searchParams.q ?? "").trim().toLowerCase();
  const category = searchParams.category ?? null;
  const filter = searchParams.filter === "mine" || searchParams.filter === "published" ? searchParams.filter : null;
  const type = searchParams.type === "report" || searchParams.type === "dashboard" ? searchParams.type : null;

  const [reports, dashboardRows, userRoles] = await Promise.all([
    prisma.report.findMany({
      where: reportWhere(user), orderBy: { updatedAt: "desc" },
      include: {
        createdBy: { select: { name: true, email: true } },
        // Only the latest run: its time and status give the freshness dot.
        // Export routes create runs too, and that is fine here — the card
        // reports when the report last ran, not what it produced.
        runs: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, status: true } },
        _count: { select: { schedules: true } },
      },
    }),
    prisma.dashboard.findMany({ where: tenantWhere(user), orderBy: { updatedAt: "desc" } }),
    getUserRoles(),
  ]);
  // Same visibility gate as GET /api/dashboards and the dashboard viewer.
  const dashboards = dashboardRows.filter((d) => canSeeDataSource(d, { id: user.id, isAdmin, roles: userRoles }));
  const dashboardOwners = new Map(
    (await prisma.user.findMany({
      where: { id: { in: Array.from(new Set(dashboards.map((d) => d.createdById))) } },
      select: { id: true, name: true, email: true },
    })).map((u) => [u.id, u]),
  );

  const labels: ReportCardData["labels"] = {
    lastRun: t(locale, "reports.lastRun"),
    neverRun: t(locale, "reports.neverRun"),
    blocks: t(locale, "reports.blocks"),
    scheduled: t(locale, "reports.schedules"),
    by: t(locale, "reports.by"),
    published: t(locale, "reports.filter.published"),
    draft: t(locale, "reports.status.draft"),
    report: t(locale, "reports.type.report"),
    dashboard: t(locale, "reports.type.dashboard"),
  };

  const reportItems: CatalogItem[] = reports.map((r) => {
    const run = r.runs[0];
    const ageMs = run ? Date.now() - new Date(run.createdAt).getTime() : Infinity;
    const freshness: ReportCardData["freshness"] = !run ? "none" : run.status === "failed" ? "crit" : ageMs > 24 * 3600 * 1000 ? "warn" : "ok";
    const shape = reportThumbnail(r.definition);
    return {
      kind: "report", at: r.updatedAt, createdById: r.createdById, published: r.published,
      category: r.category,
      text: (r.name + " " + (r.description ?? "") + " " + (r.category ?? "")).toLowerCase(),
      card: {
        id: r.id, kind: "report", href: `/reports/${r.id}`, editHref: `/reports/${r.id}/edit`,
        name: r.name, category: r.category, updatedAgo: timeAgo(r.updatedAt, locale), updatedAt: r.updatedAt.toISOString(), version: r.version,
        ownerInitials: initialsOf(r.createdBy?.name, r.createdBy?.email),
        ownerName: r.createdBy?.name ?? r.createdBy?.email ?? "",
        lastRun: run ? timeAgo(run.createdAt, locale) : null, freshness,
        schedules: r._count?.schedules ?? 0, blocks: shape.blocks, published: r.published, audience: null, shape, labels,
      },
    };
  });

  const dashboardItems: CatalogItem[] = dashboards.map((d) => {
    const owner = dashboardOwners.get(d.createdById);
    const count = (json: string) => { try { const v = JSON.parse(json); return Array.isArray(v) ? v.length : 0; } catch { return 0; } };
    const vis = readVisibility(d);
    const audience = vis.mode === "roles" ? t(locale, "reports.audience.roles").replace("{roles}", vis.roles.join(", "))
      : vis.mode === "owner_only" ? t(locale, "reports.audience.onlyMe") : null;
    const reportCount = count(d.reportIdsJson);
    return {
      kind: "dashboard", at: d.updatedAt, createdById: d.createdById, published: false, category: null,
      text: d.name.toLowerCase(),
      card: {
        id: d.id, kind: "dashboard", href: `/dashboards/${encodeURIComponent(d.slug)}`, editHref: "/dashboards/manage",
        name: d.name, category: null, updatedAgo: timeAgo(d.updatedAt, locale), updatedAt: d.updatedAt.toISOString(), version: null,
        ownerInitials: initialsOf(owner?.name, owner?.email), ownerName: owner?.name ?? owner?.email ?? "",
        lastRun: null, freshness: "none", schedules: 0, blocks: reportCount, published: null, audience,
        shape: dashboardThumbnail(count(d.topKpisJson), reportCount), labels,
      },
    };
  });

  const items = [...reportItems, ...dashboardItems].sort((a, b) => b.at.getTime() - a.at.getTime());
  // Tab counts follow the type switch but not the search, so the catalog's shape stays readable.
  const inType = items.filter((i) => !type || i.kind === type);
  const filtered = inType.filter((i) => {
    if (category && i.category !== category) return false;
    if (filter === "mine" && i.createdById !== user.id) return false;
    if (filter === "published" && !(i.kind === "report" && i.published)) return false;
    if (q && !i.text.includes(q)) return false;
    return true;
  });

  const categories = Array.from(new Set(reports.map((r) => r.category).filter(Boolean) as string[]));
  const href = (over: Partial<{ filter: string | null; type: string | null; category: string | null }>) => {
    const next = { filter, type, category: null as string | null, ...over };
    const usp = new URLSearchParams();
    if (next.filter) usp.set("filter", next.filter);
    if (next.type) usp.set("type", next.type);
    if (next.category) usp.set("category", next.category);
    if (q) usp.set("q", q);
    const qs = usp.toString();
    return qs ? `/reports?${qs}` : "/reports";
  };

  return (
    <AppShell
      breadcrumbs={[{ label: t(locale, "nav.reports") }]}
      actions={
        canCreate ? (
          <div className="flex items-center gap-2">
            <GenerateReportButton />
            {/* Hidden on the true first-run empty state (nothing yet) — the
                "Blank canvas" card below already offers the same action, and
                having both on screen at once left a brand-new user staring
                at several near-identical "start" buttons with no idea which
                to pick. Reappears once something exists. */}
            {items.length > 0 && (
              <NewMenu
                labels={{
                  create: t(locale, "reports.new"),
                  blank: t(locale, "reports.new.blank"), blankDesc: t(locale, "reports.new.blankDesc"),
                  dashboard: t(locale, "reports.new.dashboard"), dashboardDesc: t(locale, "reports.new.dashboardDesc"),
                  importFile: t(locale, "reports.new.import"), importDesc: t(locale, "reports.new.importDesc"),
                }}
              />
            )}
          </div>
        ) : null
      }
    >
      <div className="mx-auto max-w-[1264px] px-8 pb-12 pt-7">
        <PageHeader
          title={t(locale, "reports.title")}
          description={t(locale, "reports.subtitle") + " · " + t(locale, "reports.count.items")
            .replace("{filtered}", String(filtered.length))
            .replace("{total}", String(inType.length))}
        />

        <ReportsCatalogView
          items={filtered.map((i) => i.card)}
          isAdmin={isAdmin}
          toolbar={
            <>
              {/* One row: whose, search, then the two narrowing menus. Schedules
                  have their own page in this console's sections. */}
              <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
                <TypeOption label={t(locale, "reports.category.all")} href={href({ filter: null })} active={filter == null} />
                <TypeOption label={t(locale, "reports.filter.mine")} href={href({ filter: "mine" })} active={filter === "mine"} />
                <TypeOption label={t(locale, "reports.filter.published")} href={href({ filter: "published" })} active={filter === "published"} />
              </div>
              <CatalogSearch initial={q} placeholder={t(locale, "reports.search.placeholder")} />
              <CategoryMenu
                label={t(locale, "lists.col.type")}
                icon={<Shapes className="mr-1.5 h-4 w-4" />}
                allLabel={t(locale, "reports.category.all")}
                categories={["report", "dashboard"]}
                labels={{ report: t(locale, "reports.type.report"), dashboard: t(locale, "reports.type.dashboard") }}
                active={type}
                hrefFor={{ "": href({ type: null }), report: href({ type: "report" }), dashboard: href({ type: "dashboard" }) }}
              />
              {categories.length > 0 && type !== "dashboard" && (
                <CategoryMenu
                  label={t(locale, "reports.filter.category")}
                  allLabel={t(locale, "reports.category.all")}
                  categories={categories}
                  active={category}
                  hrefFor={{ "": href({ category: null }), ...Object.fromEntries(categories.map((cat) => [cat, href({ category: cat })])) }}
                />
              )}
            </>
          }
          empty={
            <>
              <EmptyState hasReports={items.length > 0} canCreate={canCreate} locale={locale} />
              {/* Marketplace nudge — only when the workspace truly has nothing
                  (the empty-state path, not a "filter returned 0" path).
                  canCreate too — viewers can't import. */}
              {items.length === 0 && canCreate && (
                <SuggestedTemplates tenantId={user.tenantId} />
              )}
            </>
          }
        />
      </div>
    </AppShell>
  );
}

function TypeOption({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={"rounded-md px-3 py-1 text-[13px] font-medium transition-colors " + (active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
    >
      {label}
    </Link>
  );
}

// Top-level tab: an underline in the accent marks the active one, with its
// count beside it in mono so the catalog's shape reads at a glance.
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
          className="group flex flex-col gap-2 rounded-lg border border-border bg-background p-4 transition-colors hover:border-foreground/30 hover:bg-muted"
        >
          <span className="flex items-center gap-2 text-sm font-semibold">
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

      <div className="mx-auto mt-6 max-w-2xl text-center text-2xs text-muted-foreground">
        {t(locale, "reports.empty.haveDb")} <Link href="/data-sources" className="text-primary hover:underline"><Database className="inline h-3 w-3" /> {t(locale, "nav.connections")}</Link> {t(locale, "reports.empty.haveDb.suffix")}
      </div>
    </div>
  );
}
