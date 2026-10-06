import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { pinRequestDbContext, withSystemDbContext } from "@/lib/dbContext";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReportWithProof, ANONYMOUS_VIEWER } from "@/lib/reporting/runner";
import { visibleReport } from "@/lib/reporting/visibleReport";
import { serverLocale } from "@/lib/i18n/serverLocale";
import { ReportDocument } from "@/components/reports/ReportDocument";
import { hashInviteToken } from "@/lib/invites";

/**
 * Chromeless, iframe-friendly read-only viewer. Same auth model as
 * /share/[token] (PublicShareToken row gates access), but rendered with no
 * AppShell, no header, no Curf branding by default - so it can drop straight
 * into a customer dashboard via:
 *
 *   <iframe src="https://your-curf/embed/<token>" style="border:0;width:100%;height:600px"/>
 *
 * Theming via query string:
 *   ?theme=light|dark    - background swap (default light)
 *   ?compact=1           - tighter padding for tight iframe heights
 *   ?brand=1             - opt back into the Curf wordmark footer
 *
 * Frame-ancestors CSP is set globally for /embed/* in next.config.mjs.
 */

export const dynamic = "force-dynamic";

export default async function EmbedPage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams?: { theme?: string; compact?: string; brand?: string };
}) {
  // The token is the credential and says whose report this is: look it up
  // across workspaces, then render as that workspace — also when the
  // visitor is signed in to a different one (row-level security, BE-TEN-03).
  const share = await withSystemDbContext(() => prisma.publicShareToken.findUnique({
    where: { tokenHash: hashInviteToken(params.token) },
  }));
  if (!share) notFound();
  pinRequestDbContext({ tenantId: share.tenantId, userId: "public", role: "viewer" });
  if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
    return <ExpiredEmbed expiredAt={new Date(share.expiresAt)} />;
  }

  const report = await prisma.report.findFirst({
    where: { id: share.reportId, tenantId: share.tenantId },
  });
  if (!report) notFound();

  const tenantRow = await prisma.tenant.findUnique({
    where: { id: share.tenantId },
    select: { currency: true },
  }).catch(() => null);

  // Same as /share/[token]: role-gated blocks, and queries only they use, stay out.
  const def = visibleReport(ReportSchema.parse(JSON.parse(report.definition)), ANONYMOUS_VIEWER);
  const pvals: Record<string, unknown> = {};
  for (const p of def.parameters) pvals[p.name] = p.default ?? "";
  // Chromeless public embed — nobody is authenticated here, so any
  // sensitivity-tagged lake column redacts by default (see ANONYMOUS_VIEWER).
  const { dataset, provenance } = await runReportWithProof({ report: def, params: pvals, tenantId: share.tenantId, viewer: ANONYMOUS_VIEWER });

  const dark = searchParams?.theme === "dark";
  const compact = searchParams?.compact === "1";
  const brand = searchParams?.brand === "1";

  return (
    <div className={"min-h-screen " + (dark ? "bg-foreground text-background" : "bg-card text-foreground")}>
      <main className={compact ? "px-4 py-3" : "px-6 py-6"}>
        <ReportDocument report={def} dataset={dataset} params={pvals} provenance={provenance} tenantCurrency={tenantRow?.currency ?? null} locale={serverLocale()} />
      </main>
      {brand && (
        <footer className={"border-t py-2 text-center text-[10px] " + (dark ? "border-faint text-muted-foreground" : "border-border text-muted-foreground")}>
          Powered by Curf
        </footer>
      )}
    </div>
  );
}

function ExpiredEmbed({ expiredAt }: { expiredAt: Date }) {
  return (
    <div className="grid min-h-screen place-items-center bg-card px-6">
      <div className="text-center">
        <p className="text-xs text-muted-foreground">
          Embed expired on {expiredAt.toLocaleDateString()}.
        </p>
      </div>
    </div>
  );
}
