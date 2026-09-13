import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";

import { ApiKeysManager } from "./ApiKeysManager";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export default async function ApiKeysPage() {
  const user = await requireUser();
  if (!user) redirect("/login?callbackUrl=/admin/api-keys");
  if (user.role !== "admin") redirect("/reports");
  const locale = readLocale();

  const [rows, reports] = await Promise.all([
    prisma.apiKey.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, prefix: true, role: true,
        lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true,
        requestCount: true, scopedReportIds: true,
      },
    }),
    prisma.report.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  const keys = rows.map((r: any) => ({
    ...r,
    scopedReportIds: r.scopedReportIds ? JSON.parse(r.scopedReportIds) : null,
  }));

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.section.admin") }, { label: t(locale, "nav.access") }]}>
      <div className="mx-auto max-w-4xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "adminApiKeys.pageTitle")} description={<>{t(locale, "adminApiKeys.pageSubtitleBefore")} <code className="font-mono">curf_...</code> {t(locale, "adminApiKeys.pageSubtitleAfter")}</>} />


        <ApiKeysManager initial={keys} reports={reports} />

        <section className="mt-10 rounded-lg border bg-muted/30 p-5 text-xs text-muted-foreground">
          <p className="mb-2 font-semibold text-foreground">{t(locale, "adminApiKeys.usingKeyTitle")}</p>
          <pre className="overflow-x-auto rounded bg-background p-3 font-mono text-[11px]">
{`# List your reports
curl https://your-domain/api/v1/reports \\
     -H "Authorization: Bearer curf_..."

# Run a report and pipe the data into anything
curl https://your-domain/api/v1/reports/<id>/data \\
     -H "Authorization: Bearer curf_..."

# Read rows from a lake table (PII redaction applied based on your role)
curl https://your-domain/api/v1/lake/tables/<name>/rows?limit=500 \\
     -H "Authorization: Bearer curf_..."`}
          </pre>
          <p className="mt-2">
            {t(locale, "adminApiKeys.docsBefore")} <a href="/api/v1/docs" className="text-primary underline" target="_blank" rel="noreferrer">/api/v1/docs</a>. {t(locale, "adminApiKeys.docsAfter")}
          </p>
        </section>
      </div>
    </AppShell>
  );
}
