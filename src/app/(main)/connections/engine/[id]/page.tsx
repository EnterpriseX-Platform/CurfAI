import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession, tenantWhere } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { EngineAdminTabs } from "@/components/engine-admin/EngineAdminTabs";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";

export const dynamic = "force-dynamic";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

/**
 * The admin console for one Java-engine data source: its status, who holds which attribute, the views reports are
 * built on, and the databases it reads. Admins only, like managing any connection.
 */
export default async function EngineAdminPage({ params, searchParams }: { params: { id: string }; searchParams: { tab?: string } }) {
  const session = await getSession();
  if (!session) redirect(`/login?callbackUrl=/connections/engine/${encodeURIComponent(params.id)}`);
  const user = session.user as any;
  if (user.role !== "admin") redirect("/connections");

  // Only an engine data source of this workspace; anything else is simply not there.
  const row = await prisma.dataSource.findFirst({ where: { id: params.id, kind: "engine", ...tenantWhere(user) }, select: { id: true, name: true } });
  if (!row) notFound();

  const locale = readLocale();
  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.connections"), href: "/connections" }, { label: row.name }]}>
      <div className="mx-auto max-w-5xl px-8 pb-12 pt-7">
        <PageHeader
          eyebrow={<Link href="/connections" className="hover:text-foreground">{t(locale, "engineAdmin.back")}</Link>}
          title={`${t(locale, "engineAdmin.title")} · ${row.name}`}
          description={t(locale, "engineAdmin.subtitle")}
        />
        <EngineAdminTabs dataSourceId={row.id} name={row.name} initialTab={searchParams.tab} />
      </div>
    </AppShell>
  );
}
