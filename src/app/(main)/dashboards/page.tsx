import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { InteractiveDashboardHub } from "./InteractiveDashboardHub";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

/**
 * Dashboards landing page — the grid/KPI hub from the Analysis App roadmap
 * (ROADMAP-ANALYSIS-APP.md Day 1). This *is* the "Dashboards" nav entry now,
 * not a second menu item next to it — a dashboard grid and the classic CRUD
 * table were two views of the same rows, so having both as separate
 * top-level nav entries read as duplicate menus. The full manage/edit/kiosk-
 * token screen still exists at /dashboards/manage, reached via this page's
 * "Manage all dashboards" link.
 */
export default async function DashboardsHubPage() {
  const session = await getSession();
  if (!session) redirect("/login?callbackUrl=/dashboards");
  const user = session.user as any;
  const isAdmin = user?.role === "admin";

  const cookieLocale = cookies().get("rd_locale")?.value;
  const locale = (cookieLocale && (LOCALES as readonly string[]).includes(cookieLocale) ? cookieLocale : "en") as Locale;

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.dashboards") }]}>
      <div className="mx-auto max-w-6xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "nav.dashboards")} description={t(locale, "dashboardsHub.subtitle")} />

        <InteractiveDashboardHub isAdmin={isAdmin} />
      </div>
    </AppShell>
  );
}
