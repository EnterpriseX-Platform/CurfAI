/**
 * /admin/release-log — what shipped in each version.
 *
 * Reads the hand-maintained RELEASE_LOG (src/lib/releaseLog.ts) — no DB
 * model, no write path. Same audience as /admin/audit: an admin who wants
 * to know "what changed" without digging through git history.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/platformAdmin";
import { AppShell } from "@/components/layout/AppShell";
import { RELEASE_LOG, type ReleaseCategory, type ReleaseChange } from "@/lib/releaseLog";
import { ee } from "@/ee";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { Sparkles, TrendingUp, Bug, ShieldAlert, ClipboardCheck, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

// Fixed display order — most-wanted-to-see first. Security is called out
// last since it reads as reassurance ("also, we hardened X") rather than
// the headline of a release.
const CATEGORY_ORDER: ReleaseCategory[] = ["feature", "improvement", "fix", "security"];

const CATEGORY_ICON: Record<ReleaseCategory, typeof Sparkles> = {
  feature: Sparkles,
  improvement: TrendingUp,
  fix: Bug,
  security: ShieldAlert,
};

const CATEGORY_CLASS: Record<ReleaseCategory, string> = {
  feature: "text-primary bg-primary/10",
  improvement: "text-primary bg-primary/10 ",
  fix: "text-warning bg-warning/10 ",
  security: "text-destructive bg-destructive/10 ",
};

function groupByCategory(changes: ReleaseChange[]): { category: ReleaseCategory; items: ReleaseChange[] }[] {
  return CATEGORY_ORDER
    .map((category) => ({ category, items: changes.filter((c) => c.category === category) }))
    .filter((g) => g.items.length > 0);
}

export default async function ReleaseLogPage() {
  const user = await requireUser();
  if (!user) redirect("/login?next=/admin/release-log");
  if (user.role !== "admin") redirect("/");

  const locale = readLocale();
  // The roadmap-status report is an operator tool that only exists in the
  // private build (src/ee); Community has no roadmap to reconcile.
  const mismatchCount = ee.operator?.roadmapMismatchCount() ?? 0;
  const roadmapLinkDesc = mismatchCount > 0
    ? t(locale, "releaseLog.roadmapLink.mismatch").replace("{n}", String(mismatchCount)).replace("{plural}", mismatchCount === 1 ? "" : "s")
    : t(locale, "releaseLog.roadmapLink.clean");

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.section.admin"), href: "/admin/tenant" }, { label: t(locale, "releaseLog.title") }]}>
      <div className="mx-auto max-w-3xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "releaseLog.title")} description={t(locale, "releaseLog.subtitle")} />


        {ee.operator && isPlatformAdmin(user) && (
          <a
            href="/admin/roadmap-status"
            className="mb-8 flex items-center gap-3 rounded-lg border border-border p-4 hover:bg-muted/50"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <ClipboardCheck className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">{t(locale, "releaseLog.roadmapLink.title")}</p>
              <p className="text-[13px] text-muted-foreground">{roadmapLinkDesc}</p>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </a>
        )}

        <ol className="relative space-y-8 border-l border-border pl-6">
          {RELEASE_LOG.map((r) => (
            <li key={r.version} className="relative">
              <span className="absolute -left-[29px] top-1 h-3 w-3 rounded-full border-2 border-background bg-primary" />
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span className="rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 font-mono text-[11px] font-semibold text-primary">
                  v{r.version}
                </span>
                <h2 className="text-sm font-semibold text-foreground">{t(locale, r.titleKey)}</h2>
                <span className="text-[11px] text-muted-foreground">{r.date}</span>
              </div>
              <div className="mt-3 space-y-3">
                {groupByCategory(r.changes).map(({ category, items }) => {
                  const Icon = CATEGORY_ICON[category];
                  return (
                    <div key={category}>
                      <div className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${CATEGORY_CLASS[category]}`}>
                        <Icon className="h-3 w-3" /> {t(locale, `releaseLog.cat.${category}`)}
                      </div>
                      <ul className="mt-1.5 space-y-1.5">
                        {items.map((c, i) => (
                          <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-muted-foreground">
                            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" />
                            {t(locale, c.textKey)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </AppShell>
  );
}
