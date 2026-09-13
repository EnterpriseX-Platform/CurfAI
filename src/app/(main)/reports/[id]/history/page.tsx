import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { ArrowLeft, Clock, History, Play, GitCompareArrows } from "lucide-react";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { HistoryActions } from "./HistoryActions";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";

export const dynamic = "force-dynamic";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

function timeAgo(d: Date | string, locale: Locale): string {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return t(locale, "time.justNow");
  const m = Math.floor(s / 60); if (m < 60) return t(locale, "time.minutesAgo").replace("{n}", String(m));
  const h = Math.floor(m / 60); if (h < 24) return t(locale, "time.hoursAgo").replace("{n}", String(h));
  return t(locale, "time.daysAgo").replace("{n}", String(Math.floor(h / 24)));
}

export default async function HistoryPage({ params }: { params: { id: string } }) {
  const locale = readLocale();
  const session = await getSession();
  const user = (session?.user as any) ?? null;
  if (!session) redirect(`/login?callbackUrl=/reports/${params.id}/history`);

  const report = await prisma.report.findFirst({ where: { id: params.id, tenantId: user.tenantId } });
  if (!report) notFound();

  const versions = await prisma.reportVersion.findMany({
    where: { reportId: params.id },
    orderBy: { version: "desc" },
    include: { createdBy: { select: { name: true, email: true } } },
    take: 50,
  });

  const runs = await prisma.reportRun.findMany({
    where: { reportId: params.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { user: { select: { name: true, email: true } } },
  });

  let actionRuns: any[] = [];
  try {
    actionRuns = await prisma.actionRun.findMany({
      where: { reportId: params.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  } catch {
    // ActionRun table doesn't exist until `prisma db push` is run.
  }

  return (
    <AppShell
      breadcrumbs={[
        { label: t(locale, "nav.reports"), href: "/reports" },
        { label: report.name, href: `/reports/${params.id}` },
        { label: t(locale, "reportHistory.breadcrumb") },
      ]}
      actions={
        <Button asChild size="sm" variant="ghost">
          <Link href={`/reports/${params.id}`}><ArrowLeft className="mr-1.5 h-4 w-4" /> {t(locale, "reportHistory.backToReport")}</Link>
        </Button>
      }
    >
      <div className="mx-auto max-w-5xl px-8 pb-12 pt-7">
        <PageHeader
          eyebrow={t(locale, "reportHistory.breadcrumb")}
          title={report.name}
          description={t(locale, "reportHistory.subtitle")}
        />

        <section className="mb-10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t(locale, "reportHistory.versionsHeading").replace("{n}", String(versions.length))}</h2>
            <span className="text-xs text-muted-foreground">{t(locale, "reportHistory.currentVersion").replace("{n}", String(report.version))}</span>
          </div>
          <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
            <table className="w-full text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colVersion")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colSaved")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colBy")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colNote")}</th>
                  <th className="w-32" />
                </tr>
              </thead>
              <tbody>
                {versions.map((v: any) => (
                  <tr key={v.id} className="border-t">
                    <td className="px-4 py-2.5 font-mono">v{v.version}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      <span title={new Date(v.createdAt).toISOString()}>{timeAgo(v.createdAt, locale)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {v.createdBy?.name ?? v.createdBy?.email ?? "\u2014"}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{v.note ?? ""}</td>
                    <td className="px-2 py-2">
                      <HistoryActions kind="restore" reportId={params.id} version={v.version} />
                    </td>
                  </tr>
                ))}
                {versions.length === 0 && (
                  <tr><td colSpan={5} className="p-10 text-center text-xs text-muted-foreground">
                    {t(locale, "reportHistory.noVersions")}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t(locale, "reportHistory.runsHeading").replace("{n}", String(runs.length))}</h2>
            {runs.filter((r: any) => r.format === "html" && r.dataset != null).length >= 2 && (
              <Button asChild size="sm" variant="ghost" title={t(locale, "reportHistory.diffTooltip")}>
                <Link href={`/reports/${params.id}/diff`}>
                  <GitCompareArrows className="mr-1.5 h-3.5 w-3.5" /> {t(locale, "reportHistory.compareRuns")}
                </Link>
              </Button>
            )}
          </div>
          <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
            <table className="w-full text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colWhen")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colFormat")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colBy")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colStatus")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colDuration")}</th>
                  <th className="w-36" />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const runParams = JSON.parse(r.params || "{}");
                  const hasSnapshot = !!(r as any).dataset;
                  return (
                    <tr key={r.id} className="border-t">
                      <td className="px-4 py-2.5 text-xs">
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          <span title={new Date(r.createdAt).toISOString()}>{timeAgo(r.createdAt, locale)}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-xs uppercase tracking-wide">{r.format}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {r.user?.name ?? r.user?.email ?? "\u2014"}
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        <span className={r.status === "completed" ? "text-success" : r.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                          {r.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs tabular-nums text-muted-foreground">
                        {r.durationMs != null ? `${r.durationMs}ms` : "\u2014"}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {r.format !== "html" && r.status === "completed" && (
                            <HistoryActions kind="redownload" reportId={r.reportId} format={r.format} runParams={runParams} />
                          )}
                          {r.format === "html" && r.status === "completed" && hasSnapshot && (
                            <Button asChild size="sm" variant="ghost" title={t(locale, "reportHistory.replayTooltip")}>
                              <Link href={`/reports/${r.reportId}?replay=${r.id}`}>
                                <Play className="mr-1.5 h-3.5 w-3.5" /> {t(locale, "reportHistory.replay")}
                              </Link>
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {runs.length === 0 && (
                  <tr><td colSpan={6} className="p-10 text-center text-xs text-muted-foreground">
                    {t(locale, "reportHistory.noRuns")}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            <strong>{t(locale, "reportHistory.replay")}</strong> {t(locale, "reportHistory.replayDesc")}{" "}
            <strong>{t(locale, "reportHistory.redownloadLabel")}</strong> {t(locale, "reportHistory.redownloadDesc")}
          </p>
        </section>

        <section className="mt-10">
          <h2 className="mb-3 text-sm font-semibold">{t(locale, "reportHistory.actionsHeading").replace("{n}", String(actionRuns.length))}</h2>
          <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
            <table className="w-full text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colWhen")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colAction")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colKind")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colBy")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colStatus")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t(locale, "reportHistory.colResponse")}</th>
                </tr>
              </thead>
              <tbody>
                {actionRuns.map((a: any) => (
                  <tr key={a.id} className="border-t">
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      <span title={new Date(a.createdAt).toISOString()}>{timeAgo(a.createdAt, locale)}</span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">{a.actionId}</td>
                    <td className="px-4 py-2.5 text-xs uppercase tracking-wide">{a.actionKind}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{a.userEmail ?? "—"}</td>
                    <td className="px-4 py-2.5 text-xs">
                      <span className={a.status === "completed" ? "text-success" : "text-destructive"}>
                        {a.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      <span className="line-clamp-1" title={a.response ?? ""}>{a.response ?? ""}</span>
                    </td>
                  </tr>
                ))}
                {actionRuns.length === 0 && (
                  <tr><td colSpan={6} className="p-10 text-center text-xs text-muted-foreground">
                    {t(locale, "reportHistory.noActions")}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            {t(locale, "reportHistory.auditNote")}
          </p>
        </section>
      </div>
    </AppShell>
  );
}
