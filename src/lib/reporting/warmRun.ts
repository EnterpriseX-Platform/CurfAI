/**
 * Warm a freshly created report — run it once and record the snapshot.
 *
 * `ReportRun` rows are only ever written by something a person did: opening
 * the viewer, exporting, a schedule firing, a watcher checking. Nothing
 * writes one at creation time, so a report born from Master Builder has no
 * run until somebody opens it. Two consequences, and the second is the one
 * that matters:
 *
 *   - The reports list draws each card's thumbnail from the latest run, and
 *     deliberately executes nothing itself (44 cards would otherwise mean 44
 *     query runs per page load). A pack that builds five reports therefore
 *     lands as five grey "No run yet" tiles.
 *   - More seriously, a generated report whose SQL doesn't actually run ships
 *     looking identical to one that works. The build reports success, the
 *     card looks the same as any other unopened report, and the failure
 *     surfaces later, to whoever opens it first.
 *
 * Running once at creation fixes both, at the cheapest possible moment: the
 * lake tables were generated seconds earlier and the author is already
 * waiting on the build.
 *
 * Best-effort by contract. A warm-up that fails must never fail the build —
 * the report exists and may well run fine later against different
 * parameters. The caller gets the error to put in its receipt instead.
 */
import { prisma } from "@/lib/db";
import { ReportSchema } from "./schema";
import { runReportWithProof } from "./runner";

export type WarmRunResult =
  | { ok: true; durationMs: number; rows: number }
  | { ok: false; durationMs: number; error: string };

/**
 * Run `reportId` once with its parameter defaults and store the result as a
 * ReportRun, exactly as the viewer does on a normal load.
 *
 * Mirrors the viewer's own snapshot rules (see reports/[id]/page.tsx): cap
 * the stored dataset at 2 MB and drop provenance alongside it when the
 * dataset is too big to keep, so a warm run and a viewed run produce
 * interchangeable history rows rather than two shapes the History and Diff
 * surfaces have to tell apart.
 */
export async function warmRunReport(args: {
  tenantId: string;
  reportId: string;
  userId?: string | null;
}): Promise<WarmRunResult> {
  const { tenantId, reportId, userId } = args;
  const started = Date.now();

  try {
    const row = await prisma.report.findFirst({
      where: { id: reportId, tenantId },
      select: { id: true, definition: true },
    });
    if (!row) return { ok: false, durationMs: Date.now() - started, error: "Report not found" };

    const report = ReportSchema.parse(JSON.parse(row.definition));
    const pvals: Record<string, unknown> = {};
    for (const p of report.parameters) pvals[p.name] = p.default ?? "";

    // Warm-up runs as an admin viewer on purpose: this is a system action on
    // a report the build just created, not a read on behalf of whoever
    // happens to be looking. Row-level visibility still applies at view time,
    // when a real viewer's identity is known.
    const result = await runReportWithProof({
      report,
      params: pvals,
      viewer: { id: userId ?? "system", isAdmin: true, roles: [] },
    });

    const datasetJson = JSON.stringify(result.dataset);
    const snapshot = datasetJson.length < 2_000_000 ? datasetJson : null;
    const rows = Object.values(result.dataset).reduce(
      (n, list) => n + (Array.isArray(list) ? list.length : 0),
      0,
    );
    const durationMs = Date.now() - started;

    await prisma.reportRun.create({
      data: {
        tenantId,
        reportId,
        format: "html",
        params: JSON.stringify(pvals),
        status: "completed",
        durationMs,
        dataset: snapshot,
        provenance: snapshot ? JSON.stringify(result.provenance ?? {}) : null,
        userId: userId ?? null,
      },
    });

    return { ok: true, durationMs, rows };
  } catch (e: any) {
    const error = e?.message ?? String(e);
    const durationMs = Date.now() - started;
    // Record the failure as a run too. A report that cannot execute is worth
    // seeing in History — a card that stays blank because the query is broken
    // should be distinguishable from one nobody has opened.
    await prisma.reportRun
      .create({
        data: {
          tenantId, reportId, format: "html", params: "{}",
          status: "failed", error, durationMs, dataset: null, provenance: null,
          userId: userId ?? null,
        },
      })
      .catch(() => null);
    return { ok: false, durationMs, error };
  }
}
