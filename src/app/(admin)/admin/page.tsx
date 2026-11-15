/**
 * /admin — where an admin starts. The sidebar's Admin section lists every
 * page, so this one only answers "is the workspace healthy?": AI credits,
 * seats, connections, what happened lately. Without it /admin was a 404.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Database, Users, Cpu } from "lucide-react";
import { requireUser, tenantWhere } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { aiCreditStatus, countSeats } from "@/lib/billing";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { relative } from "@/lib/i18n/formatDate";
import { auditInWords } from "@/lib/audit/inWords";

export const dynamic = "force-dynamic";

async function readLocale(): Promise<Locale> {
  const v = (await cookies()).get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export default async function AdminHomePage() {
  const user = await requireUser();
  if (!user) redirect("/login?callbackUrl=/admin");
  if (user.role !== "admin") redirect("/");
  const locale = await readLocale();
  const tr = (k: string) => t(locale, k);

  const [credits, seats, connections, events] = await Promise.all([
    aiCreditStatus(user.tenantId).catch(() => null),
    countSeats(user.tenantId).catch(() => null),
    prisma.dataSource.count({ where: tenantWhere(user) }).catch(() => null),
    prisma.auditEvent.findMany({
      where: tenantWhere(user),
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { id: true, kind: true, userEmail: true, createdAt: true },
    }).catch(() => []),
  ]);

  const unlimited = credits != null && !Number.isFinite(credits.allowance);
  const pct = credits && !unlimited && credits.allowance > 0 ? Math.min(100, Math.round((credits.used / credits.allowance) * 100)) : 0;
  const low = credits != null && !unlimited && pct >= 80;
  const resetDate = credits
    ? new Date(credits.resetsAt).toLocaleDateString(locale === "th" ? "th-TH" : locale === "zh" ? "zh-CN" : "en-GB", { day: "numeric", month: "short", timeZone: "UTC" })
    : "";

  return (
    <AppShell breadcrumbs={[{ label: tr("nav.section.admin") }]}>
      <div className="mx-auto max-w-[1264px] px-8 pb-12 pt-7">
        <PageHeader title={tr("nav.section.admin")} description={tr("admin.home.subtitle")} />

        <section className="grid gap-3 sm:grid-cols-3" aria-label={tr("admin.home.health")}>
          <Link href="/admin/usage" className="rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-input">
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[.04em] text-muted-foreground"><Cpu className="h-3.5 w-3.5" /> {tr("admin.home.credits")}</p>
            {credits ? (
              unlimited ? (
                <p className="mt-2 text-2xl font-semibold">{tr("admin.home.unlimited")}</p>
              ) : (
                <>
                  <p className="mt-2 text-2xl font-semibold tabular-nums">{credits.used.toLocaleString()} <span className="text-sm font-normal text-muted-foreground">/ {credits.allowance.toLocaleString()}</span></p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <div className={`h-full rounded-full ${low ? "bg-destructive" : "bg-primary"}`} style={{ width: `${pct}%` }} />
                  </div>
                  <p className={`mt-2 text-xs ${low ? "font-medium text-destructive" : "text-muted-foreground"}`}>
                    {tr(low ? "admin.home.creditsLow" : "admin.home.creditsResets").replace("{date}", resetDate)}
                  </p>
                </>
              )
            ) : <p className="mt-2 text-sm text-muted-foreground">—</p>}
          </Link>

          <Link href="/admin/users" className="rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-input">
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[.04em] text-muted-foreground"><Users className="h-3.5 w-3.5" /> {tr("admin.home.seats")}</p>
            {seats ? (
              <>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{seats.editors}</p>
                <p className="mt-2 text-xs text-muted-foreground">{tr("admin.home.seatsDetail").replace("{editors}", String(seats.editors)).replace("{viewers}", String(seats.viewers))}</p>
              </>
            ) : <p className="mt-2 text-sm text-muted-foreground">—</p>}
          </Link>

          <Link href="/connections" className="rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-input">
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[.04em] text-muted-foreground"><Database className="h-3.5 w-3.5" /> {tr("admin.home.connections")}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{connections ?? "—"}</p>
            <p className="mt-2 text-xs text-muted-foreground">{tr("admin.home.connectionsHint")}</p>
          </Link>
        </section>

        <section className="mt-8" aria-labelledby="admin-recent">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 id="admin-recent" className="text-xs font-semibold uppercase tracking-[.08em] text-faint">{tr("admin.home.recent")}</h2>
            <Link href="/admin/audit" className="text-xs font-medium text-primary hover:underline">{tr("admin.home.recentAll")}</Link>
          </div>
          {events.length ? (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {events.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="min-w-0 truncate">
                    {(() => {
                      const w = auditInWords(e.kind);
                      return w ? <span data-testid="recent-words">{tr("auditWords.line").replace("{verb}", tr(w.verb)).replace("{noun}", tr(w.family))} </span> : <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs">{e.kind}</code>;
                    })()}{" "}
                    <span className="text-muted-foreground">{e.userEmail ?? ""}</span>
                  </span>
                  <span className="flex-none text-xs text-muted-foreground">{relative(e.createdAt, locale)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{tr("admin.home.recentEmpty")}</p>
          )}
        </section>
      </div>
    </AppShell>
  );
}
