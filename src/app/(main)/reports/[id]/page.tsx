import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSession, getUserRoles } from "@/lib/auth";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReportWithProof, type RunViewer } from "@/lib/reporting/runner";
import { visibleReport } from "@/lib/reporting/visibleReport";
import { ee } from "@/ee";
import { ReportDocument } from "@/components/reports/ReportDocument";
import { ReportViewerShell } from "./ReportViewerShell";
import { LOCALES } from "@/lib/i18n/dict";
import type { Dataset } from "@/lib/reporting/interpolate";
import type { ProvenanceMap } from "@/lib/reporting/provenance";
import { runOutcome } from "@/lib/reporting/queryRunState";
import { verifyRenderToken } from "@/lib/reporting/renderToken";
import { savedRunReader, parseSavedRun } from "@/lib/reporting/snapshotAccess";

export const dynamic = "force-dynamic";

export default async function ViewerPage({
  params, searchParams,
}: {
  params: { id: string };
  searchParams: Record<string, string | undefined>;
}) {
  const print = searchParams.print === "1";
  // A print render comes from our own PDF/XLSX worker, which has no user
  // cookie to forward on the cron and schedule paths — so it proves itself
  // with a short-lived signed token naming this exact report instead.
  //
  // `print=1` alone used to BE the credential: it skipped the /login
  // redirect and dropped tenantId from the lookup below, so appending it to
  // any report id read that report unauthenticated, across tenants. The
  // token carries the tenant, which is what puts scoping back on this path.
  const render = print
    ? verifyRenderToken(
        typeof searchParams.rt === "string" ? searchParams.rt : null,
        params.id,
      )
    : null;

  const session = await getSession();
  const sessionUser = (session?.user as any) ?? null;
  if (!sessionUser?.tenantId && !render) {
    // A worker with a missing/expired/foreign token is not a person to send
    // to a login form — fail it the same way a deleted report does.
    if (print) notFound();
    redirect(`/login?callbackUrl=/reports/${params.id}`);
  }
  const tenantId: string = sessionUser?.tenantId ?? render!.tenantId;
  // Who the report's queries run as, when no one is signed in: the viewer the
  // render token names, i.e. the API key or schedule creator that asked for
  // the file. These renders used to pass no viewer, which the runner treats
  // as the system, so they skipped the data-source ACL and lake redaction.
  const tokenViewer = sessionUser?.tenantId ? null : render!.viewer;

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

  // Always tenant-scoped now, print or not. The print branch keeps its
  // narrower select only because the page header it feeds isn't rendered.
  const row = print
    ? await prisma.report.findFirst({ where: { id: params.id, tenantId } })
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
  const definition = ReportSchema.parse(JSON.parse(row.definition));

  // RBAC: hide blocks gated by visibleToRoles that don't match the viewer's roles.
  // Admins always see everything UNLESS they opted into ?previewAsRole=slug
  // (comma-separated). In that case we filter as if they had only those roles,
  // so authors can validate what an executive/analyst/new_hire would see.
  const isAdmin = sessionUser?.role === "admin";
  const previewParam = typeof searchParams.previewAsRole === "string" ? searchParams.previewAsRole.trim() : "";
  const previewRoles = previewParam ? previewParam.split(",").map((r) => r.trim()).filter(Boolean) : null;
  const userRoles = previewRoles && isAdmin ? previewRoles : await getUserRoles();
  const effectiveAdmin = previewRoles && isAdmin ? false : isAdmin;
  // With no session, the render token says whose blocks to show. An on-demand
  // export shows its caller's (the API key asking for the file), so its PDF
  // has the blocks its XLSX/DOCX/CSV have, see visibleReport() in
  // lib/reporting/visibleReport.ts. A scheduled delivery's token doesn't, and
  // its blocks filter as a viewer with no roles, as these renders always
  // have: its data runs as the creator, but an admin's delivery never gains
  // role-gated blocks. The cron filters its other formats the same way.
  const blocksAs = tokenViewer
    ? (render!.blocksAsViewer ? tokenViewer : { roles: [], isAdmin: false })
    : { roles: userRoles, isAdmin: effectiveAdmin };
  // The queries only hidden blocks used are dropped too: everything below
  // reaches the browser, the dataset included.
  const report = visibleReport(definition, blocksAs);
  const shown = new Set(report.dataSources.map((q) => q.id));
  // Who the queries run as (and a replayed run is filtered as): the signed-in
  // viewer, or with no session the viewer the render token names.
  const runAs: RunViewer = tokenViewer ?? { id: (sessionUser as any).id, isAdmin: effectiveAdmin, roles: userRoles };
  const withheld = definition.dataSources.map((q) => q.id).filter((id) => !shown.has(id));

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
      // The run may be someone else's — rows from sources this viewer can't
      // see, for blocks hidden from them, from an older version of the
      // report — so it's read as this viewer: only what their report reads,
      // gated as a live run would be (lib/reporting/snapshotAccess.ts).
      const saved = await savedRunReader(tenantId, report, runAs)(parseSavedRun(run));
      dataset = saved.dataset;
      provenance = saved.provenance;
      pvals = saved.params;
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
      const result = await runReportWithProof({ report, params: pvals, tenantId, viewer: runAs });
      dataset = result.dataset;
      provenance = result.provenance;
      // No-ops (zero extra queries) unless a KPI block on this report has
      // metricRef set — see docs/SEMANTIC_METRIC_LAYER.md.
      try {
        if (ee.metrics) await ee.metrics.enrichDatasetWithMetrics(dataset, report, row.tenantId, pvals, runAs);
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
        // A load that threw, or in which a query didn't run, must not be recorded as a
        // healthy "completed" snapshot: it would become the day's latest KPI-history point
        // and the next run's "previous" value (see runOutcome).
        const outcome = runError
          ? { status: "failed" as const, error: String(runError.message).slice(0, 500) }
          : runOutcome(provenance, withheld.length);
        await prisma.reportRun.create({
          data: {
            tenantId: row.tenantId,
            reportId: row.id,
            format: "html",
            params: JSON.stringify(pvals),
            status: outcome.status,
            error: outcome.error ?? null,
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
