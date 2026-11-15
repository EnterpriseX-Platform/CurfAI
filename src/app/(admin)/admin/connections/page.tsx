/**
 * /admin/connections — incremental-sync connection list.
 *
 * One row per SyncConnection. Shows the kind (postgres / salesforce /
 * stripe), the name the user gave it, an enabled chip, and a one-line
 * summary of the most recent SyncRun across all of this connection's
 * jobs. Click any row to drill into /admin/connections/[id]/syncs for
 * the per-object status view.
 *
 * Read-only at this level; New connection opens /admin/connections/new.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, tenantWhere } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/layout/AppShell";
import { Database, Cable, CreditCard, Cloud, ArrowRight, CircleDot, Plus } from "lucide-react";
import { cookies } from "next/headers";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { relative } from "@/lib/i18n/formatDate";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

const KIND_META: Record<string, { label: string; icon: typeof Database }> = {
  postgres:   { label: "Postgres",   icon: Database },
  salesforce: { label: "Salesforce", icon: Cloud },
  stripe:     { label: "Stripe",     icon: CreditCard },
};

const STATUSES = ["ok", "partial", "failed", "running"];

export default async function ConnectionsPage() {
  const user = await requireUser();
  if (!user) redirect("/login?next=/admin/connections");
  if (user.role !== "admin") redirect("/");

  const c = await cookies();
  const cookieLocale = c.get("rd_locale")?.value;
  const locale = (cookieLocale && (LOCALES as readonly string[]).includes(cookieLocale) ? cookieLocale : "en") as Locale;

  let connections: any[] = [];
  try {
    connections = await prisma.syncConnection.findMany({
      where: tenantWhere(user),
      orderBy: { createdAt: "desc" },
    });
  } catch {
    /* sync tables not yet pushed — show the empty state */
  }

  // Pull the latest run per connection in one query. The SyncRun table
  // is indexed on (connectionId, startedAt) so this is fast at any size.
  const connIds = connections.map((c) => c.id);
  let latestRuns: Record<string, any> = {};
  if (connIds.length > 0) {
    try {
      const allRuns: any[] = await prisma.syncRun.findMany({
        where: { connectionId: { in: connIds } },
        orderBy: { startedAt: "desc" },
        select: { connectionId: true, status: true, rowsWritten: true, finishedAt: true, startedAt: true },
      });
      for (const r of allRuns) {
        if (!latestRuns[r.connectionId]) latestRuns[r.connectionId] = r;
      }
    } catch { /* SyncRun table may be empty; that's fine */ }
  }

  // Count jobs per connection so we can show "3 syncs configured" badges.
  let jobCounts: Record<string, number> = {};
  if (connIds.length > 0) {
    try {
      const grouped = await prisma.syncJob.groupBy({
        by: ["connectionId"] as const,
        where: { connectionId: { in: connIds } },
        _count: { _all: true },
      });
      for (const g of grouped) jobCounts[g.connectionId] = g._count._all;
    } catch { /* SyncJob may be empty */ }
  }

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.section.admin") }, { label: t(locale, "adminPages.connections.title") }]}>
      <div className="mx-auto max-w-[1264px] px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "adminPages.connections.title")} description={t(locale, "adminPages.connections.subtitle")} actions={<><Link href="/admin/connections/new" className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground hover:opacity-90" > <Plus className="h-4 w-4" /> {t(locale, "adminPages.connections.new")} </Link></>} />


        {connections.length === 0 ? (
          <section className="rounded-lg border border-dashed border-border bg-muted/20 p-10 text-center">
            <Cable className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <h3 className="mt-3 text-sm font-semibold">{t(locale, "admin.connections.empty")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(locale, "admin.connections.emptyDesc")}
            </p>
            <Link
              href="/admin/connections/new"
              className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" />
              {t(locale, "adminPages.connections.new")}
            </Link>
          </section>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {connections.map((c) => {
              const meta = KIND_META[c.kind] ?? { label: c.kind, icon: Database };
              const Icon = meta.icon;
              const run = latestRuns[c.id];
              const count = jobCounts[c.id] ?? 0;
              return (
                <li key={c.id} className="group">
                  <Link href={`/admin/connections/${c.id}/syncs`} className="flex items-center gap-4 px-5 py-4 transition hover:bg-accent/30">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground">{c.name}</span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-2xs uppercase tracking-wider text-muted-foreground">
                          {meta.label}
                        </span>
                        {!c.enabled && (
                          <span className="rounded-full bg-warning/10 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-warning">
                            {t(locale, "admin.connections.disabled")}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-2xs text-muted-foreground">
                        <span>{count === 1 ? t(locale, "admin.connections.syncsOne") : t(locale, "admin.connections.syncsMany").replace("{n}", String(count))}</span>
                        {run && (
                          <>
                            <span className="opacity-40">·</span>
                            <span className="inline-flex items-center gap-1">
                              <CircleDot className={`h-2.5 w-2.5 ${statusColor(run.status)}`} />
                              {t(locale, "admin.connections.lastRun")
                                .replace("{status}", STATUSES.includes(run.status) ? t(locale, `admin.connections.status.${run.status}`) : run.status)
                                .replace("{rows}", Number(run.rowsWritten ?? 0).toLocaleString())}
                            </span>
                            <span className="opacity-40">·</span>
                            <span suppressHydrationWarning>
                              {relative(run.finishedAt ?? run.startedAt, locale)}
                            </span>
                          </>
                        )}
                        {!run && count > 0 && (
                          <>
                            <span className="opacity-40">·</span>
                            <span>{t(locale, "admin.connections.noRuns")}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/40 transition group-hover:text-muted-foreground" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </AppShell>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "ok":      return "text-success";
    case "partial": return "text-warning";
    case "failed":  return "text-destructive";
    case "running": return "text-primary animate-pulse";
    default:        return "text-muted-foreground/50";
  }
}
