/**
 * /admin/audit — paginated audit-log explorer.
 *
 * Every recordAudit() call across the app lands in AuditEvent. This page
 * lets a workspace admin (or a security questionnaire reviewer with a
 * deeplink) browse those rows with filter chips for:
 *   - kind family ("report.*", "lake.*", "tenant.*", etc.)
 *   - exact kind
 *   - user (email substring)
 *   - target (id substring)
 *   - time window (24h | 7d | 30d | all)
 *
 * Pagination is offset-based (page=N) — table caps at 50 rows per page.
 * For tenants with millions of rows, the deep-link pattern + the time
 * filter keeps the working set small. We never load the whole tenant log
 * into memory.
 *
 * Replaces an earlier minimal version that only had kind chips. Rebuilt
 * for the compliance-questionnaire use case: a reviewer should be able
 * to land here and reconstruct what happened to a specific report,
 * specific user, or specific time window in <30 seconds.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/layout/AppShell";
import { ObservabilityTabs } from "@/components/layout/ObservabilityTabs";
import { ChevronLeft, ChevronRight, Search, X, User as UserIcon } from "lucide-react";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

type SearchParams = {
  kind?: string;
  family?: string;
  user?: string;
  target?: string;
  window?: "24h" | "7d" | "30d" | "all";
  page?: string;
};

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const locale = readLocale();
  const user = await requireUser();
  if (!user) redirect("/login?next=/admin/audit");
  if (user.role !== "admin") redirect("/");

  const params: Required<SearchParams> = {
    kind: searchParams.kind ?? "",
    family: searchParams.family ?? "",
    user: searchParams.user ?? "",
    target: searchParams.target ?? "",
    window: (searchParams.window ?? "7d") as any,
    page: searchParams.page ?? "1",
  };
  const page = Math.max(1, Number(params.page) || 1);

  const where: any = { tenantId: user.tenantId };
  if (params.kind) where.kind = params.kind;
  else if (params.family) where.kind = { startsWith: params.family + "." };
  if (params.user) where.userEmail = { contains: params.user };
  if (params.target) where.target = { contains: params.target };
  if (params.window !== "all") {
    const days = params.window === "24h" ? 1 : params.window === "30d" ? 30 : 7;
    where.createdAt = { gte: new Date(Date.now() - days * DAY_MS) };
  }

  let events: any[] = [];
  let total = 0;
  let kindStats: Array<{ kind: string; n: number }> = [];
  try {
    [events, total] = await Promise.all([
      prisma.auditEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      }),
      prisma.auditEvent.count({ where }),
    ]);
    // "Kind family" sidebar — group recent rows by the namespace before
    // the dot so the user sees what's worth filtering by.
    const recent = await prisma.auditEvent.findMany({
      where: { tenantId: user.tenantId, createdAt: { gte: new Date(Date.now() - 30 * DAY_MS) } },
      select: { kind: true },
      take: 5000,
    });
    const counts = new Map<string, number>();
    for (const r of recent) {
      const fam = r.kind.split(".")[0] || r.kind;
      counts.set(fam, (counts.get(fam) ?? 0) + 1);
    }
    kindStats = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([k, n]) => ({ kind: k, n }));
  } catch {
    /* AuditEvent table missing pre-db-push */
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.section.admin"), href: "/admin/tenant" }, { label: t(locale, "admin.audit.title") }]}>
      <div className="mx-auto max-w-6xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "admin.audit.title")} description={t(locale, "admin.audit.description")} />


        <ObservabilityTabs locale={locale} active="/admin/audit" />

        {/* FILTERS */}
        <form method="GET" className="mb-4 grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-4">
          <input type="hidden" name="page" value="1" />

          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t(locale, "admin.audit.filterTimeWindow")}</span>
            <select name="window" defaultValue={params.window} className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs">
              <option value="24h">{t(locale, "admin.audit.timeLast24h")}</option>
              <option value="7d">{t(locale, "admin.audit.timeLast7d")}</option>
              <option value="30d">{t(locale, "admin.audit.timeLast30d")}</option>
              <option value="all">{t(locale, "admin.audit.timeAll")}</option>
            </select>
          </label>

          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t(locale, "admin.audit.filterKind")}</span>
            <input
              name="kind"
              defaultValue={params.kind}
              placeholder={t(locale, "admin.audit.kindPlaceholder")}
              className="mt-1 h-8 w-full rounded border border-border bg-background px-2 font-mono text-xs"
            />
          </label>

          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t(locale, "admin.audit.filterUserEmail")}</span>
            <input
              name="user"
              defaultValue={params.user}
              placeholder={t(locale, "admin.audit.userEmailPlaceholder")}
              className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs"
            />
          </label>

          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t(locale, "admin.audit.filterTargetId")}</span>
            <input
              name="target"
              defaultValue={params.target}
              placeholder={t(locale, "admin.audit.targetIdPlaceholder")}
              className="mt-1 h-8 w-full rounded border border-border bg-background px-2 font-mono text-xs"
            />
          </label>

          <input type="hidden" name="family" value={params.family} />

          <div className="flex items-center justify-between gap-2 md:col-span-4">
            <div className="flex flex-wrap items-center gap-1.5">
              {kindStats.map((k) => (
                <Link
                  key={k.kind}
                  href={qs({ ...params, family: k.kind, kind: "", page: "1" })}
                  className={
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium " +
                    (params.family === k.kind
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border bg-muted/40 text-muted-foreground hover:bg-muted")
                  }
                >
                  {k.kind} <span className="tabular-nums opacity-70">{k.n}</span>
                </Link>
              ))}
              {(params.family || params.kind || params.user || params.target) && (
                <Link
                  href={qs({ window: params.window } as any)}
                  className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/20"
                >
                  <X className="h-3 w-3" /> {t(locale, "action.clear")}
                </Link>
              )}
            </div>
            <button
              type="submit"
              className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90"
            >
              <Search className="h-3 w-3" /> {t(locale, "action.apply")}
            </button>
          </div>
        </form>

        {/* RESULT TABLE */}
        <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {t(locale, "admin.audit.eventsMatch")
              .replace("{n}", total.toLocaleString())
              .replace("{plural}", total === 1 ? "" : "s")}
          </span>
          <span>{t(locale, "admin.audit.pageOf").replace("{page}", String(page)).replace("{total}", pageCount.toLocaleString())}</span>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {events.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              {t(locale, "admin.audit.noEvents")}
            </p>
          ) : (
            <table className="w-full text-xs" style={{ tableLayout: "fixed" }}>
              <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="w-[150px] px-3 py-2 text-left">{t(locale, "admin.audit.colWhen")}</th>
                  <th className="w-[160px] px-3 py-2 text-left">{t(locale, "admin.audit.colKind")}</th>
                  <th className="w-[170px] px-3 py-2 text-left">{t(locale, "admin.audit.colUser")}</th>
                  <th className="px-3 py-2 text-left">{t(locale, "admin.audit.colTarget")}</th>
                  <th className="w-[110px] px-3 py-2 text-left">{t(locale, "admin.audit.colIp")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((e) => (
                  <tr key={e.id} className="hover:bg-muted/30">
                    <td className="truncate px-3 py-1.5 text-muted-foreground">
                      <span title={new Date(e.createdAt).toISOString()}>{relativeTime(e.createdAt)}</span>
                    </td>
                    <td className="px-3 py-1.5">
                      <Link
                        href={qs({ ...params, kind: e.kind, family: "", page: "1" })}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold hover:bg-muted/70"
                      >
                        {e.kind}
                      </Link>
                    </td>
                    <td className="truncate px-3 py-1.5">
                      {e.userEmail ? (
                        <Link href={qs({ ...params, user: e.userEmail, page: "1" })} className="truncate hover:underline">
                          <UserIcon className="mr-1 inline h-3 w-3 text-muted-foreground" />
                          {e.userEmail}
                        </Link>
                      ) : (
                        <span className="italic text-muted-foreground">{t(locale, "admin.audit.systemUser")}</span>
                      )}
                    </td>
                    <td className="truncate px-3 py-1.5">
                      {e.target ? (
                        <details className="group">
                          <summary className="cursor-pointer truncate font-mono text-[11px] text-muted-foreground hover:text-foreground">
                            {e.target.slice(0, 24)}{e.target.length > 24 ? "…" : ""}
                          </summary>
                          <div className="mt-1 space-y-1 rounded border border-border bg-background p-2">
                            <div>
                              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t(locale, "admin.audit.targetIdInline")}</span>
                              <div className="break-all font-mono text-[11px]">{e.target}</div>
                            </div>
                            {e.metaJson && e.metaJson !== "{}" && (
                              <div>
                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t(locale, "admin.audit.meta")}</span>
                                <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[10px]">{prettyJson(e.metaJson)}</pre>
                              </div>
                            )}
                          </div>
                        </details>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="truncate px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
                      {e.ip ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* PAGINATION */}
        {pageCount > 1 && (
          <div className="mt-3 flex items-center justify-end gap-2 text-xs">
            <PageLink params={params} page={page - 1} disabled={page <= 1}><ChevronLeft className="h-3 w-3" /> {t(locale, "admin.audit.prev")}</PageLink>
            <span className="text-muted-foreground tabular-nums">
              {t(locale, "admin.audit.rangeOfTotal")
                .replace("{from}", String(((page - 1) * PAGE_SIZE) + 1))
                .replace("{to}", String(Math.min(page * PAGE_SIZE, total)))
                .replace("{total}", total.toLocaleString())}
            </span>
            <PageLink params={params} page={page + 1} disabled={page >= pageCount}>{t(locale, "admin.audit.next")} <ChevronRight className="h-3 w-3" /></PageLink>
          </div>
        )}
      </div>
    </AppShell>
  );
}

// ---- Helpers ---------------------------------------------------------------

function qs(p: Required<SearchParams> | Partial<Required<SearchParams>>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v != null && v !== "") out.set(k, String(v));
  }
  return "/admin/audit?" + out.toString();
}

function relativeTime(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d).getTime() : d.getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
  if (diff < 604_800_000) return Math.floor(diff / 86_400_000) + "d ago";
  return new Date(t).toLocaleDateString();
}

function prettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); }
  catch { return s; }
}

function PageLink({ params, page, disabled, children }: { params: Required<SearchParams>; page: number; disabled?: boolean; children: React.ReactNode }) {
  if (disabled) {
    return (
      <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-muted/30 px-2 text-[11px] text-muted-foreground opacity-50">
        {children}
      </span>
    );
  }
  return (
    <Link href={qs({ ...params, page: String(page) })} className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] hover:bg-muted">
      {children}
    </Link>
  );
}
