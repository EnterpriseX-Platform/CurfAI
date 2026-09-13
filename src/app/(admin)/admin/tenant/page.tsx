import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";
import { Users, FileText, Database } from "lucide-react";
import { TenantRenameForm } from "./TenantRenameForm";
import { CurrencyPanel } from "./CurrencyPanel";
import { RegionPanel } from "./RegionPanel";
import { PdpaRecordPanel, type PdpaRecord } from "./PdpaRecordPanel";
import { LlmProviderPanel } from "./LlmProviderPanel";
import { LakeEnginePanel } from "./LakeEnginePanel";
import { SmtpPanel } from "./SmtpPanel";
import { DeleteWorkspacePanel } from "./DeleteWorkspacePanel";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { PageHeader } from "@/components/layout/PageHeader";
import { EDITION } from "@/lib/ee/edition";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

/**
 * Tenant settings page. Admin-only. Shows the Tenant row + member/report/ds
 * counts and lets admins rename the workspace. Slug is intentionally
 * read-only - changing it would break every bookmarked URL in the tenant.
 */
export const dynamic = "force-dynamic";

export default async function TenantSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login?callbackUrl=/admin/tenant");
  if (user.role !== "admin") redirect("/reports");

  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    include: { _count: { select: { memberships: true, reports: true, dataSources: true } } },
  });
  if (!tenant) redirect("/reports");
  const locale = readLocale();
  let pdpaRecord: PdpaRecord | null = null;
  try {
    const parsed = JSON.parse(tenant.pdpaRecordJson ?? "{}");
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) pdpaRecord = parsed;
  } catch { /* corrupt — treat as unset */ }
  const otherMemberships = (user.memberships ?? []).filter((m) => !m.isVirtual && m.tenantId !== tenant.id);

  const stats = [
    { label: t(locale, "adminTenant.members"),    value: tenant._count.memberships, Icon: Users },
    { label: t(locale, "nav.reports"),            value: tenant._count.reports,     Icon: FileText },
    { label: t(locale, "nav.connections"),        value: tenant._count.dataSources, Icon: Database },
  ];

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.section.admin") }, { label: t(locale, "nav.tenant") }]}>
      <div className="mx-auto max-w-3xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "adminTenant.pageTitle")} description={t(locale, "adminTenant.pageSubtitle")} />


        <section className="mb-8 rounded-lg border bg-card p-5 shadow-xs">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t(locale, "adminTenant.identity")}
          </p>
          <TenantRenameForm initial={{ id: tenant.id, name: tenant.name, slug: tenant.slug }} />
          <p className="mt-3 text-xs text-muted-foreground">
            {t(locale, "adminTenant.slugImmutable")} {t(locale, "adminTenant.created").replace("{date}", new Date(tenant.createdAt).toLocaleDateString())}
          </p>
        </section>

        <CurrencyPanel initial={tenant.currency ?? null} />

        <RegionPanel initial={tenant.region ?? null} />

        <PdpaRecordPanel initial={pdpaRecord} tenantName={tenant.name} region={tenant.region ?? null} />

        <LlmProviderPanel />

        <SmtpPanel />

        {/* DuckDB engine flip is Growth — its API is absent in Community. */}
        {EDITION !== "community" && <LakeEnginePanel />}

        <DeleteWorkspacePanel
          tenant={{ id: tenant.id, name: tenant.name, slug: tenant.slug }}
          otherWorkspaceCount={otherMemberships.length}
          fallbackTenantId={otherMemberships[0]?.tenantId}
        />

        <section className="grid grid-cols-3 gap-3">
          {stats.map(({ label, value, Icon }) => (
            <div key={label} className="rounded-lg border bg-card p-5 shadow-xs">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Icon className="h-3.5 w-3.5" /> {label}
              </div>
              <div className="font-semibold tabular-nums text-2xl">{value}</div>
            </div>
          ))}
        </section>
      </div>
    </AppShell>
  );
}
