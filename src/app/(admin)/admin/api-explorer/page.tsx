/**
 * /admin/api-explorer — Swagger-style live tester for the public
 * /api/v1 surface. Admin-only. Reads the endpoint catalog from
 * /api/v1/docs at request time (client-side) so it never drifts from
 * what's actually documented there.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";

import { ApiExplorerClient } from "./ApiExplorerClient";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export default async function ApiExplorerPage() {
  const user = await requireUser();
  if (!user) redirect("/login?next=/admin/api-explorer");
  if (user.role !== "admin") redirect("/");
  const locale = readLocale();

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.section.admin"), href: "/admin/tenant" }, { label: t(locale, "nav.apiExplorer") }]}>
      <div className="mx-auto max-w-5xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "apiExplorer.pageTitle")} description={t(locale, "apiExplorer.pageSubtitle")} />


        <ApiExplorerClient />
      </div>
    </AppShell>
  );
}
