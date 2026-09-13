import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/layout/AppShell";
import { SchedulesManager } from "./SchedulesManager";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export default async function SchedulesPage() {
  const session = await getSession();
  const user = (session?.user as any) ?? null;
  if (!session) redirect("/login?callbackUrl=/schedules");
  const locale = readLocale();

  const reports = await prisma.report.findMany({
    where: { tenantId: user.tenantId }, orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "schedules.breadcrumb") }]}>
      <div className="mx-auto max-w-5xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "schedules.pageTitle")} description={t(locale, "schedules.pageSubtitle")} />

        <SchedulesManager reports={reports} />
        <div className="mt-10 rounded-lg border border-dashed bg-muted/30 p-5 text-xs text-muted-foreground">
          <p className="mb-2 font-semibold text-foreground">{t(locale, "schedules.cronRunnerTitle")}</p>
          <p className="mb-2">
            {t(locale, "schedules.cronRunnerBody")}
          </p>
          <pre className="overflow-auto rounded bg-background p-2 font-mono text-[11px]">
{`# Example cron entry: every Monday 07:00
0 7 * * 1  curl -sX POST https://reports.example.com/api/schedules/<id>/run \\
             -H "Authorization: Bearer $API_TOKEN" -o - \\
             | mail -s "Weekly sales report" -a "Content-Type: application/pdf" team@example.com`}
          </pre>
        </div>
      </div>
    </AppShell>
  );
}
