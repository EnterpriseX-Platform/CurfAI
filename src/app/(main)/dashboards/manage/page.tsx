import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";
import { loadTenantTier } from "@/lib/billing";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { DashboardsManager } from "./DashboardsManager";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

/**
 * Full CRUD table for dashboards — create/edit/delete, kiosk tokens,
 * visibility ACL. Reached from the /dashboards hub's "Manage all
 * dashboards" link, not from the sidebar directly (no separate nav entry —
 * see src/app/(main)/dashboards/page.tsx's docstring for why). Mirrors
 * /data-sources structure: shell + heading + client manager component that
 * does its own fetching.
 *
 * Visibility ACL is enforced server-side by /api/dashboards GET, so we don't
 * have to filter here — the client just renders whatever the API returns.
 */
export default async function DashboardsManagePage() {
  const session = await getSession();
  if (!session) redirect("/login?callbackUrl=/dashboards/manage");
  const user = session.user as any;
  const isAdmin = user?.role === "admin";
  // Read tenant tier fresh so the kiosk-token panel can render UpgradeLock
  // for non-Business tenants. Same rationale as /data-sources/page.tsx.
  const tier = await loadTenantTier(user.tenantId);

  const cookieLocale = cookies().get("rd_locale")?.value;
  const locale = (cookieLocale && (LOCALES as readonly string[]).includes(cookieLocale) ? cookieLocale : "en") as Locale;

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.dashboards"), href: "/dashboards" }, { label: t(locale, "dashboardsMgr.manage") }]}>
      <div className="mx-auto max-w-5xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "nav.dashboards")} description={<>{t(locale, "dashboards.subtitle")} {isAdmin ? t(locale, "dashboards.subtitle.admin") : t(locale, "dashboards.subtitle.viewer")}</>} />

        <Suspense fallback={null}>
          <DashboardsManager isAdmin={isAdmin} currentTier={tier} />
        </Suspense>
      </div>
    </AppShell>
  );
}
