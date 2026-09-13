import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { ArrowLeft, TrendingUp, TrendingDown, Equal, Plus, Minus } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { ReportSchema } from "@/lib/reporting/schema";
import { diffDatasets, type QueryDiff, type FieldChange } from "@/lib/reporting/diff";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/reporting/format";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

/**
 * Time-travel diff view. Pass `?from=RUN_ID&to=RUN_ID` (or the page will pick
 * the two most recent snapshots by default) and see every cell-level change
 * between those two report runs - KPI deltas, rows added/removed, fields
 * that flipped. This is the Trust Layer paying rent: because every run is
 * snapshotted (dataset + provenance), any two runs can be diffed exactly.
 */

export const dynamic = "force-dynamic";

export default async function DiffPage({
  params, searchParams,
}: {
  params: { id: string };
  searchParams: { from?: string; to?: string };
}) {
  const locale = readLocale();
  const user = await requireUser();
  if (!user) redirect(`/login?callbackUrl=/reports/${params.id}/diff`);

  const report = await prisma.report.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!report) notFound();

  // Pick the two runs to compare. Explicit ids win; otherwise take the two
  // most recent snapshots (first = newer, second = older).
  const runsWithDataset = await prisma.reportRun.findMany({
    where: { reportId: params.id, dataset: { not: null }, status: "completed" },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, createdAt: true, format: true },
  });

  const toId = searchParams.to ?? runsWithDataset[0]?.id;
  const fromId = searchParams.from ?? runsWithDataset[1]?.id;

  if (!toId || !fromId) {
    return (
      <AppShell
        breadcrumbs={[
          { label: t(locale, "nav.reports"), href: "/reports" },
          { label: report.name, href: `/reports/${params.id}` },
          { label: t(locale, "reportDiff.breadcrumb") },
        ]}
        actions={<BackButton reportId={params.id} locale={locale} />}
      >
        <div className="mx-auto max-w-3xl px-8 py-10 text-sm text-muted-foreground">
          {t(locale, "reportDiff.needTwoRuns")}
        </div>
      </AppShell>
    );
  }

  // Load both runs in this tenant and parse their datasets.
  const [toRun, fromRun] = await Promise.all([
    prisma.reportRun.findFirst({
      where: { id: toId, reportId: params.id, tenantId: user.tenantId },
      select: { id: true, createdAt: true, dataset: true },
    }),
    prisma.reportRun.findFirst({
      where: { id: fromId, reportId: params.id, tenantId: user.tenantId },
      select: { id: true, createdAt: true, dataset: true },
    }),
  ]);

  if (!toRun?.dataset || !fromRun?.dataset) notFound();

  const toDataset = safeParse<Record<string, any[]>>(toRun.dataset) ?? {};
  const fromDataset = safeParse<Record<string, any[]>>(fromRun.dataset) ?? {};
  const diff = diffDatasets(fromDataset, toDataset);

  // Resolve friendly query names from the report definition so we can label
  // each section with something readable (not just a queryId).
  const reportDef = ReportSchema.safeParse(JSON.parse(report.definition));
  const queryNameById = new Map<string, string>();
  if (reportDef.success) {
    for (const ds of reportDef.data.dataSources) {
      queryNameById.set(ds.id, ds.name ?? ds.id);
    }
  }

  return (
    <AppShell
      breadcrumbs={[
        { label: t(locale, "nav.reports"), href: "/reports" },
        { label: report.name, href: `/reports/${params.id}` },
        { label: t(locale, "reportDiff.breadcrumb") },
      ]}
      actions={<BackButton reportId={params.id} locale={locale} />}
    >
      <div className="mx-auto max-w-5xl px-8 pb-12 pt-7">
        <PageHeader
          eyebrow={t(locale, "reportDiff.eyebrow")}
          title={report.name}
          description={<>
            {t(locale, "reportDiff.comparing")} {new Date(fromRun.createdAt).toLocaleString()}{" "}
            {t(locale, "reportDiff.older")} &rarr;{" "}
            {new Date(toRun.createdAt).toLocaleString()} {t(locale, "reportDiff.newer")}
          </>}
          actions={<>
            <DeltaChip kind="added"    n={diff.totals.added} locale={locale} />
            <DeltaChip kind="removed"  n={diff.totals.removed} locale={locale} />
            <DeltaChip kind="changed"  n={diff.totals.changed} locale={locale} />
          </>}
        />

        {diff.queries.length === 0 && (
          <p className="text-sm text-muted-foreground">{t(locale, "reportDiff.bothEmpty")}</p>
        )}

        <div className="space-y-6">
          {diff.queries.map((q) => (
            <QuerySection
              key={q.queryId}
              q={q}
              label={queryNameById.get(q.queryId) ?? q.queryId}
              locale={locale}
            />
          ))}
        </div>

        <p className="mt-10 text-[11px] text-muted-foreground">
          {t(locale, "reportDiff.footerNote")}
        </p>
      </div>
    </AppShell>
  );
}

function BackButton({ reportId, locale }: { reportId: string; locale: Locale }) {
  return (
    <Button asChild size="sm" variant="ghost">
      <Link href={`/reports/${reportId}/history`}>
        <ArrowLeft className="mr-1.5 h-4 w-4" /> {t(locale, "reportDiff.backToHistory")}
      </Link>
    </Button>
  );
}

function DeltaChip({ kind, n, locale }: { kind: "added" | "removed" | "changed"; n: number; locale: Locale }) {
  const cls =
    kind === "added"   ? "bg-success/10 text-success border-success/30" :
    kind === "removed" ? "bg-destructive/10 text-destructive border-destructive/30" :
                         "bg-warning/10 text-warning border-warning/30";
  const Icon = kind === "added" ? Plus : kind === "removed" ? Minus : Equal;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${cls}`}>
      <Icon className="h-3 w-3" />
      {n} {t(locale, `reportDiff.${kind}`)}
    </span>
  );
}

function QuerySection({ q, label, locale }: { q: QueryDiff; label: string; locale: Locale }) {
  const unchanged = q.counts.unchanged;
  const nothingHappened =
    (q.shape === "scalar" && (!q.scalarChanges || q.scalarChanges.length === 0)) ||
    (q.shape === "rows"   && q.counts.added + q.counts.removed + q.counts.changed === 0);

  return (
    <section className="rounded-lg border bg-card p-5 shadow-xs">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {label} <span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground">{q.queryId}</span>
        </h2>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {q.shape === "scalar" ? t(locale, "reportDiff.kpiRow") : t(locale, "reportDiff.rowsCount").replace("{n}", String(q.counts.added + q.counts.removed + q.counts.changed + unchanged))}
          {unchanged > 0 && <span className="text-muted-foreground/60">· {t(locale, "reportDiff.unchanged").replace("{n}", String(unchanged))}</span>}
        </div>
      </div>

      {nothingHappened ? (
        <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t(locale, "reportDiff.noChanges")}</p>
      ) : q.shape === "scalar" ? (
        <ScalarChanges changes={q.scalarChanges ?? []} />
      ) : (
        <RowChanges q={q} locale={locale} />
      )}
    </section>
  );
}

function ScalarChanges({ changes }: { changes: FieldChange[] }) {
  return (
    <ul className="divide-y divide-border">
      {changes.map((c) => (
        <li key={c.key} className="flex items-baseline justify-between gap-4 py-2 text-sm">
          <span className="font-mono text-xs text-muted-foreground">{c.key}</span>
          <span className="tabular-nums">
            <span className="text-muted-foreground">{fmt(c.before)}</span>
            <span className="mx-2 text-muted-foreground">&rarr;</span>
            <span className="font-semibold">{fmt(c.after)}</span>
            {c.pct != null && (
              <span className={`ml-2 inline-flex items-center gap-0.5 text-xs ${c.pct >= 0 ? "text-success" : "text-destructive"}`}>
                {c.pct >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {formatPercent(Math.abs(c.pct))}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RowChanges({ q, locale }: { q: QueryDiff; locale: Locale }) {
  const rows = q.rowDiffs ?? [];
  // Show interesting rows first (added / removed / changed); hide unchanged.
  const interesting = rows.filter((r) => r.kind !== "unchanged");
  if (interesting.length === 0) {
    return <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t(locale, "reportDiff.noRowChanges")}</p>;
  }
  return (
    <div className="divide-y divide-border overflow-hidden rounded-md border">
      {interesting.map((r, i) => {
        if (r.kind === "added") {
          return (
            <div key={i} className="flex items-start gap-3 bg-success/5 px-3 py-2 text-xs">
              <Plus className="mt-0.5 h-3.5 w-3.5 text-success shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 font-medium text-success">{t(locale, "reportDiff.newRow")}</div>
                <div className="font-mono text-[11px] text-muted-foreground break-words">{summarise(r.row)}</div>
              </div>
            </div>
          );
        }
        if (r.kind === "removed") {
          return (
            <div key={i} className="flex items-start gap-3 bg-destructive/5 px-3 py-2 text-xs">
              <Minus className="mt-0.5 h-3.5 w-3.5 text-destructive shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 font-medium text-destructive">{t(locale, "reportDiff.removedRow")}</div>
                <div className="font-mono text-[11px] text-muted-foreground break-words">{summarise(r.row)}</div>
              </div>
            </div>
          );
        }
        // changed
        return (
          <div key={i} className="flex items-start gap-3 bg-warning/5 px-3 py-2 text-xs">
            <Equal className="mt-0.5 h-3.5 w-3.5 text-warning shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 font-medium text-warning font-mono text-[11px]">{r.id}</div>
              <ul className="space-y-0.5">
                {r.changes.map((c) => (
                  <li key={c.key} className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
                    <span className="font-mono">{c.key}</span>
                    <span className="tabular-nums">{fmt(c.before)}</span>
                    <span>&rarr;</span>
                    <span className="tabular-nums font-semibold text-foreground">{fmt(c.after)}</span>
                    {c.pct != null && (
                      <span className={c.pct >= 0 ? "text-success" : "text-destructive"}>
                        ({c.pct >= 0 ? "+" : ""}{formatPercent(c.pct)})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function summarise(row: Record<string, unknown>): string {
  return Object.entries(row).slice(0, 6).map(([k, v]) => `${k}=${fmt(v)}`).join(" · ");
}

function fmt(v: unknown): string {
  if (v == null) return "\u2014";
  if (typeof v === "number") {
    if (Math.abs(v) >= 1000 && Number.isFinite(v)) return formatNumber(v);
    return String(v);
  }
  return String(v);
}

function safeParse<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}
