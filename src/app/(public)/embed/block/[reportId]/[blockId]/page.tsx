/**
 * /embed/[reportId]/[blockId] — public iframe-friendly single-block render.
 *
 * Auth model:
 *   - If the report is on a published Public App, the block is renderable
 *     anonymously (matches public app semantics — same data exposure).
 *   - Otherwise the request needs `?token=<signed>`, where the token was
 *     minted server-side with the tenant's secret. This lets a customer
 *     embed a private block on their intranet without exposing the wider
 *     report.
 *
 * Output is intentionally chrome-less — no nav, no header, no sidebar.
 * Just the block, sized to the viewport. iframe consumers control the
 * outer chrome.
 */
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReport } from "@/lib/reporting/runner";
import { serverLocale } from "@/lib/i18n/serverLocale";
import { ReportDocument } from "@/components/reports/ReportDocument";
import { verifyEmbedToken } from "@/lib/embed/token";

export const dynamic = "force-dynamic";
// No-cache so the iframe always reflects latest data when the parent
// page reloads. If the consumer wants caching they can wrap the iframe
// themselves.
export const revalidate = 0;

type Props = {
  params: { reportId: string; blockId: string };
  searchParams: { token?: string; [key: string]: string | undefined };
};

export default async function EmbedBlockPage({ params, searchParams }: Props) {
  // 1. Resolve auth: token-mint OR public-app-derived.
  const tokenPayload = searchParams.token ? verifyEmbedToken(searchParams.token) : null;
  let tenantId: string | null = null;
  let frozenParams: Record<string, unknown> = {};

  if (tokenPayload) {
    if (tokenPayload.r !== params.reportId || tokenPayload.b !== params.blockId) {
      return <EmbedError message="Token does not match this block." />;
    }
    tenantId = tokenPayload.t;
    frozenParams = tokenPayload.p ?? {};
  } else {
    // Anonymous path — only allowed if the report has a published public app.
    const app = await prisma.app.findFirst({
      where: { reportId: params.reportId, published: true },
      select: { tenantId: true },
    });
    if (!app) return <EmbedError message="This block is private. Embed token required." />;
    tenantId = app.tenantId;
  }

  // 2. Load + run the report inside the resolved tenant.
  const reportRow = await prisma.report.findFirst({
    where: { id: params.reportId, tenantId: tenantId! },
  });
  if (!reportRow) return notFound();
  const report = ReportSchema.parse(JSON.parse(reportRow.definition));
  const tenantRow = await prisma.tenant.findUnique({
    where: { id: tenantId! },
    select: { currency: true },
  }).catch(() => null);

  // Find the block.
  let block: any = null;
  let pageIdx = 0;
  for (let i = 0; i < report.pages.length; i++) {
    const found = (report.pages[i].blocks as any[]).find((b) => b.id === params.blockId);
    if (found) { block = found; pageIdx = i; break; }
  }
  if (!block) return <EmbedError message="Block not found in this report." />;

  // 3. Resolve params: frozen-from-token wins, then ?p.* overrides for
  //    public-app embeds, then report defaults.
  const pvals: Record<string, unknown> = {};
  for (const p of report.parameters) {
    if (p.name in frozenParams) pvals[p.name] = frozenParams[p.name];
    else if (searchParams[`p.${p.name}`] != null) pvals[p.name] = searchParams[`p.${p.name}`];
    else pvals[p.name] = p.default ?? "";
  }

  let dataset: any = {};
  try {
    dataset = await runReport({ report, params: pvals });
  } catch (e: any) {
    console.warn("[embed] runReport failed:", e?.message);
  }

  // 4. Synthesise a single-block "report" so we can reuse ReportDocument.
  //    This gives us themes, conditional formatting, the whole renderer,
  //    without forking a second renderer just for embeds.
  const singleBlockReport = {
    ...report,
    pages: [{
      ...report.pages[pageIdx],
      blocks: [block],
    }],
  };

  return (
    <div
      // The iframe consumer typically sizes the outer iframe; the embed
      // itself just fills whatever space it's given. p-3 ensures we don't
      // cut hover shadows off at the edge.
      className="min-h-screen bg-background p-3"
      data-curf-embed="1"
      data-curf-report-id={params.reportId}
      data-curf-block-id={params.blockId}
    >
      <ReportDocument
        report={singleBlockReport as any}
        dataset={dataset}
        params={pvals}
        reportDbId={params.reportId}
        tenantCurrency={tenantRow?.currency ?? null}
        locale={serverLocale()}
      />
      {/* Tiny attribution. Light, unobtrusive — clickable backlink to Curf. */}
      <a
        href="https://curf.ai"
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-block text-[9px] uppercase tracking-wider text-muted-foreground/50 hover:text-muted-foreground"
      >
        Powered by Curf
      </a>
    </div>
  );
}

function EmbedError({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-center">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-destructive">Embed unavailable</p>
        <p className="mt-1 text-sm text-foreground">{message}</p>
      </div>
    </div>
  );
}
