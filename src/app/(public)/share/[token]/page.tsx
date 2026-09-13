import { notFound } from "next/navigation";
import Link from "next/link";
import { Globe } from "lucide-react";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReportWithProof } from "@/lib/reporting/runner";
import { serverLocale } from "@/lib/i18n/serverLocale";
import { localizeReport } from "@/lib/reporting/localize";
import { ReportDocument } from "@/components/reports/ReportDocument";
import { CurfLogo } from "@/components/common/CurfLogo";

/**
 * Auth-free public view of a report, unlocked by a PublicShareToken. The
 * token scopes access - we look up the token, resolve the report + tenant,
 * run the report live against its tenant's data sources, and render
 * read-only. No login, no session, no designer access.
 *
 * URL: /share/<token>
 */

export const dynamic = "force-dynamic";

export default async function PublicSharePage({ params }: { params: { token: string } }) {
  const share = await prisma.publicShareToken.findUnique({
    where: { token: params.token },
  });
  if (!share) notFound();
  if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
    return (
      <ExpiredShell expiredAt={new Date(share.expiresAt)} />
    );
  }

  const report = await prisma.report.findFirst({
    where: { id: share.reportId, tenantId: share.tenantId },
  });
  if (!report) notFound();

  const tenantRow = await prisma.tenant.findUnique({
    where: { id: share.tenantId },
    select: { currency: true },
  }).catch(() => null);

  const def = ReportSchema.parse(JSON.parse(report.definition));
  const locale = serverLocale();
  const localized = localizeReport(def, locale);
  // Public shares don't accept parameters via URL (design choice - keeps the
  // share stable). Use each parameter's default.
  const pvals: Record<string, unknown> = {};
  for (const p of def.parameters) pvals[p.name] = p.default ?? "";
  const { dataset, provenance } = await runReportWithProof({ report: def, params: pvals });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-6 py-3">
          <Link href="/" className="flex items-center gap-2">
            <CurfLogo variant="lockup" size={20} />
          </Link>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Globe className="h-3 w-3" />
            <span>Public share</span>
            {share.expiresAt && (
              <span className="text-muted-foreground/70">
                · expires {new Date(share.expiresAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">
        {/* The DB row's name is the authoring language; the definition is
            what carries nameI18n. Using report.name here left the heading in
            English while the report under it rendered Thai — the exact
            "shared link shows English" complaint this closes. */}
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">{localized.name}</h1>
        {localized.description && (
          <p className="mb-6 text-sm text-muted-foreground">{localized.description}</p>
        )}
        <ReportDocument report={localized} dataset={dataset} params={pvals} provenance={provenance} tenantCurrency={tenantRow?.currency ?? null} locale={locale} />
      </main>
      <footer className="border-t border-border py-4 text-center text-[11px] text-muted-foreground">
        Shared from <Link href="/" className="underline">Curf</Link>. Read-only public view.
      </footer>
    </div>
  );
}

function ExpiredShell({ expiredAt }: { expiredAt: Date }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background px-6">
      <div className="text-center">
        <h1 className="mb-2 text-lg font-semibold">Share link expired</h1>
        <p className="text-sm text-muted-foreground">
          This public share expired on {expiredAt.toLocaleDateString()}. Ask the report owner for a fresh link.
        </p>
      </div>
    </div>
  );
}
