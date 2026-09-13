import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";
import { loadTenantTier } from "@/lib/billing";
import { DataSourcesManager } from "./DataSourcesManager";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export default async function DataSourcesPage() {
  const session = await getSession();
  const user = (session?.user as any) ?? null;
  if (!session) redirect("/login?callbackUrl=/data-sources");
  const locale = readLocale();

  const isAdmin = (session.user as any)?.role === "admin";
  // Load the tenant's plan tier server-side so the kind picker can show
  // UpgradeLock pills next to gated connectors (Postgres/MySQL → Team,
  // Snowflake/BigQuery → Business). We read it fresh from the DB rather
  // than from the session because subscription upgrades land via webhook
  // and we want them to take effect immediately on the next page load.
  const tier = await loadTenantTier(user.tenantId);

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.connections") }]}>
      <div className="mx-auto max-w-5xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "connections.pageTitle")} description={<>{t(locale, "connections.pageSubtitleShared")} {isAdmin ? t(locale, "connections.adminCanEdit") : t(locale, "connections.onlyAdminsEdit")}</>} />

        <DataSourcesManager isAdmin={isAdmin} currentTier={tier} />
      </div>
    </AppShell>
  );
}
