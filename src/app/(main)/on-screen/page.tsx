import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";
import { loadTenantTier } from "@/lib/billing";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { OnScreenManager } from "./OnScreenManager";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

/**
 * On Screen list page. Mirrors /dashboards/page.tsx structure exactly —
 * shell + heading + client manager component that does its own fetching.
 *
 * Visibility ACL is enforced server-side by /api/on-screen GET, so we don't
 * have to filter here — the client just renders whatever the API returns.
 */
export default async function OnScreenPage() {
  const session = await getSession();
  if (!session) redirect("/login?callbackUrl=/on-screen");
  const user = session.user as any;
  const isAdmin = user?.role === "admin";
  const tier = await loadTenantTier(user.tenantId);

  const cookieLocale = cookies().get("rd_locale")?.value;
  const locale = (cookieLocale && (LOCALES as readonly string[]).includes(cookieLocale) ? cookieLocale : "en") as Locale;

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.onScreen") }]}>
      <div className="mx-auto max-w-5xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "nav.onScreen")} description={t(locale, "onScreen.subtitle")} />

        <OnScreenManager isAdmin={isAdmin} currentTier={tier} />
      </div>
    </AppShell>
  );
}
