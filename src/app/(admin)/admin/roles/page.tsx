import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";
import { prisma } from "@/lib/db";
import { RolesManager } from "./RolesManager";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export default async function RolesAdminPage() {
  const session = await getSession();
  const user = (session?.user as any) ?? null;
  if (!session) redirect("/login?callbackUrl=/admin/roles");
  if ((session.user as any)?.role !== "admin") redirect("/reports");
  const locale = readLocale();

  const roles = await prisma.role.findMany({ where: { tenantId: user.tenantId }, orderBy: { slug: "asc" } });

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.section.admin") }, { label: t(locale, "adminRoles.breadcrumb") }]}>
      <div className="mx-auto max-w-4xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "adminRoles.pageTitle")} description={t(locale, "adminRoles.pageSubtitle")} />

        <RolesManager initialRoles={roles} />
      </div>
    </AppShell>
  );
}
