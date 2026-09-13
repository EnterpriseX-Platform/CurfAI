import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSession, getUserRoles, filterBlocksForRoles } from "@/lib/auth";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReportWithProof } from "@/lib/reporting/runner";
import { ee } from "@/ee";
import { ReportDocument } from "@/components/reports/ReportDocument";
import { ReportViewerShell } from "./ReportViewerShell";
import { LOCALES } from "@/lib/i18n/dict";
import type { Dataset } from "@/lib/reporting/interpolate";
import type { ProvenanceMap } from "@/lib/reporting/provenance";

export const dynamic = "force-dynamic";

export default async function ViewerPage({
  params, searchParams,
}: {
  params: { id: string };
  searchParams: Record<string, string | undefined>;
}) {
  const print = searchParams.print === "1";
  const session = await getSession();
  if (!session && !print) redirect(`/login?callbackUrl=/reports/${params.id}`);
  const sessionUser = (session?.user as any) ?? null;
  if (!sessionUser?.tenantId && !print) redirect("/login");
  const tenantId: string = sessionUser?.tenantId ?? "";

  // Personalization layer — read user preferences + tenant brand alongside
  // the report. ThemeProvider resolves with userOverride → report.theme →
  // tenantDefault precedence; the viewer keeps their preferred theme even
  // when the author chose differently.
  let userPrefs: any = {};
  let tenantBrand: any = {};
  let tenantCurrency: string | null = null;
  try {
    if (sessionUser?.id) {
      const r = await prisma.user.findUnique({
        where: { id: sessionUser.id },
        select: { preferencesJson: true } as any,
      });
      if (r) userPrefs = JSON.parse((r as any).preferencesJson || "{}");
    }
    if (tenantId) {
      const t = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { brandJson: true, currency: true } as any,
      });
      if (t) {
        tenantBrand = JSON.parse((t as any).brandJson || "{}");
        tenantCurrency = (t as any).currency ?? null;
      }
    }
  } catch { /* missing column = empty prefs, fine until db push runs */ }

  const row = print
    ? await prisma.report.findUnique({ where: { id: params.id } })
    : await prisma.report.findFirst({
        where: { id: params.id, tenantId },
        // The viewer's page header names who published the report.
        include: { createdBy: { select: { name: true, email: true } } },
      });
  if (!row) {
    // print (Puppeteer PDF capture) genuinely means the report is gone —
    // stays a hard 404 so a broken export fails loudly instead of silently
    // rendering a PDF of the Reports list. Interactive browsing hits this
    // far more often just from switching workspaces while the URL still
    // points at a report that belongs to the tenant you just left — a bare
    // "This page could not be found" reads as broken; bounce to the
    // report list they DO have instead.
    if (print) notFound();
    redirect("/reports");
  }
  const report = ReportSchema.parse(JSON.parse(row.definition));

  // RBAC: hide blocks gated by visibleToRoles that don't match the viewer's roles.
  // Admins always see everything UNLESS they opted into ?previewAsRole=slug
  // (comma-separated). In that case we filter as if they had only those roles,
  // so authors can validate what an executive/analyst/new_hire would see.
  const isAdmin = sessionUser?.role === "admin";
  const previewParam = typeof searchParams.previewAsRole === "string" ? searchParams.previewAsRole.trim() : "";
  const previewRoles = previewParam ? previewParam.split(",").map((r) => r.trim()).filter(Boolean) : null;
  const userRoles = previewRoles && isAdmin ? previewRoles : await getUserRoles();
  const effectiveAdmin = previewRoles && isAdmin ? false : isAdmin;
  for (const page of report.pages) {
    const { visible } = filterBlocksForRoles(page.blocks as any[], userRoles, effectiveAdmin);
    page.blocks = visible as any;
  }

  // Time-travel: if ?replay=<runId> is present, load the snapshotted dataset
  // and provenance from that past run instead of executing queries live.
  const replayId = typeof searchParams.replay === "string" ? searchParams.replay : null;
  let dataset: Dataset = {};
  let provenance: ProvenanceMap = {};
  let pvals: Record<string, unknown> = {};
  let replayedAt: string | null = null;

  if (replayId) {
    const run = await prisma.reportRun.findFirst({
      where: { id: replayId, tenantId, reportId: row.id },
    });
    if (run && run.dataset) {
      dataset = JSON.parse(run.dataset);
      provenance = run.provenance ? JSON.parse(run.provenance) : {};
      pvals = run.params ? JSON.parse(run.params) : {};
      replayedAt = run.createdAt instanceof Date ? run.createdAt.toISOString() : String(run.createdAt);
    }
  }

  // Per-load error captured if the runner throws - we want to render the
  // report anyway so blocks can show "no data" placeholders rather than
  // letting the exception bubble into the React Server Component stream
  // (which Next.js then sends back as an HTML error page, breaking
  // hydration and producing the dreaded "Unexpected token '<'" client crash).
  let runError: { message: string } | null = null;

  if (!replayedAt) {
    for (const p of report.parameters) {
      const v = searchParams[`p.${p.name}`];
      pvals[p.name] = v ?? p.default ?? "";
    }
    const started = Date.now();
    try {
      // Defense-in-depth: pass viewer identity so the runner skips queries
      // against DataSources the viewer can't see (visibility ACL). Empty
      // rows + a proof note land in the dataset instead of a leak.
      const result = await runReportWithProof({
        report,
        params: pvals,
        viewer: sessionUser
          ? { id: (sessionUser as any).id, isAdmin: effectiveAdmin, roles: userRoles }
          : undefined,
      });
      dataset = result.dataset;
      provenance = result.provenance;
      // No-ops (zero extra queries) unless a KPI block on this report has
      // metricRef set — see docs/SEMANTIC_METRIC_LAYER.md.
      try {
        if (ee.metrics) await ee.metrics.enrichDatasetWithMetrics(dataset, report, row.tenantId, pvals);
      } catch (err) {
        console.error("[viewer] enrichDatasetWithMetrics failed:", err);
      }
    } catch (err: any) {
      console.error("[viewer] runReportWithProof failed:", err);
      runError = { message: err?.message ?? String(err ?? "Unknown error") };
      dataset = {};
      provenance = {};
    }

    // Record a ReportRun for every viewer load (non-replay). This feeds the
    // History page so time-travel becomes usable without a separate action.
    // Snapshot up to 2 MB — larger datasets get metadata only.
    if (!print) {
      try {
        const datasetJson = JSON.stringify(dataset);
        const snapshot = datasetJson.length < 2_000_000 ? datasetJson : null;
        await prisma.reportRun.create({
          data: {
            tenantId: row.tenantId,
            reportId: row.id,
            format: "html",
            params: JSON.stringify(pvals),
            status: "completed",
            durationMs: Date.now() - started,
            dataset: snapshot,
            provenance: snapshot ? JSON.stringify(provenance) : null,
            userId: sessionUser?.id ?? null,
          },
        });
      } catch (err) {
        // Don't break the viewer if logging fails - but surface the cause in
        // dev logs so missing tenantId / schema drift doesn't silently break
        // the History and Diff surfaces.
        console.error("[viewer] reportRun.create failed:", err);
      }
    }
  }

  if (print) {
    // This branch (Puppeteer's PDF/print capture, see
    // lib/reporting/renderers/pdf.ts) renders ReportDocument directly
    // instead of going through ReportViewerShell — so it needs its own
    // server-side locale resolution, same pattern as RootLayout's
    // initialLocale, rather than inheriting ReportViewerShell's
    // useT()-sourced one.
    const cookieLocale = cookies().get("rd_locale")?.value;
    const locale = cookieLocale && (LOCALES as readonly string[]).includes(cookieLocale) ? cookieLocale : undefined;
    return (
      <div className="bg-card">
        {/* provenance is what lets the PDF carry each KPI's run receipt
            (hash · run time · rows) — the interactive proof popover itself
            is suppressed by `print`. */}
        <ReportDocument report={report} dataset={dataset} params={pvals} print provenance={provenance} locale={locale} tenantCurrency={tenantCurrency} />
      </div>
    );
  }

  return (
    <ReportViewerShell
      reportId={row.id}
      report={report}
      initialParams={pvals}
      initialDataset={dataset}
      initialProvenance={provenance}
      version={row.version}
      updatedAt={row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt)}
      author={(row as any).createdBy?.name ?? (row as any).createdBy?.email ?? null}
      replayedAt={replayedAt}
      previewAsRole={previewRoles && isAdmin ? previewRoles.join(",") : null}
      runError={runError}
      userPrefs={userPrefs}
      tenantBrand={tenantBrand}
      tenantCurrency={tenantCurrency}
    />
  );
}
