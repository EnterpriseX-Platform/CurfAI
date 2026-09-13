/**
 * Story Mode (Tier 4 — ai.story_mode, Business plan).
 *
 * Auto-generated walkthrough: each block in the report becomes a slide
 * with auto-advance, a progress bar, and keyboard nav. Built as a thin
 * wrapper over the same data-fetch pipeline as the regular viewer — no
 * separate query path, so any block that renders in the viewer renders
 * here.
 *
 * Why this is shaped like a deck rather than a long scroll:
 *   - one block per slide forces the eye to ONE thing at a time
 *   - auto-advance turns a static report into a hands-free briefing
 *   - the progress bar gives an obvious sense of "where am I" in the
 *     story without needing a sidebar
 *
 * The Server Component path here only does data + tier check; the
 * interactive slide controls live in StoryViewer (client).
 */
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSession, getUserRoles, filterBlocksForRoles } from "@/lib/auth";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReportWithProof } from "@/lib/reporting/runner";
import { tierAtLeast } from "@/lib/billing";
import { StoryViewer } from "./StoryViewer";

export const dynamic = "force-dynamic";

export default async function StoryModePage({ params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) redirect(`/login?callbackUrl=/reports/${params.id}/story`);
  const sessionUser = (session.user as any) ?? null;
  if (!sessionUser?.tenantId) redirect("/login");

  // Tier gate. Story Mode is Business-only; non-Business tenants land on a
  // dedicated upgrade prompt rather than the live viewer (we don't want
  // half-rendered slides or an awkward "feature locked" overlay inside an
  // already-immersive deck experience).
  const tenant = await prisma.tenant.findUnique({ where: { id: sessionUser.tenantId } });
  const tier = (tenant as any)?.tier ?? "community";
  if (!tierAtLeast(tier, "business")) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/30 p-8">
        <div className="max-w-md rounded-2xl border border-border bg-background p-8 text-center shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">Story Mode</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">A briefing, not a scroll.</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Story Mode turns your report into a hands-free walkthrough — one
            block per slide, auto-advancing, with the AI caption surfaced
            for each chart. Available on the Business plan.
          </p>
          <a
            href="/admin/billing"
            className="mt-6 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Upgrade to Business
          </a>
        </div>
      </div>
    );
  }

  const row = await prisma.report.findFirst({
    where: { id: params.id, tenantId: sessionUser.tenantId },
  });
  if (!row) notFound();
  const report = ReportSchema.parse(JSON.parse(row.definition));

  // Apply the same RBAC filter the viewer does so a block hidden from the
  // viewer doesn't sneak through Story Mode.
  const userRoles = await getUserRoles();
  const isAdmin = sessionUser?.role === "admin";
  for (const page of report.pages) {
    const { visible } = filterBlocksForRoles(page.blocks as any[], userRoles, isAdmin);
    page.blocks = visible as any;
  }

  // Default parameters — Story Mode runs against the canonical view, no
  // search-param override surface (deck UX wants one source of truth).
  const pvals: Record<string, unknown> = {};
  for (const p of report.parameters) {
    pvals[p.name] = p.default ?? "";
  }

  let dataset = {};
  let provenance = {};
  try {
    const result = await runReportWithProof({
      report,
      params: pvals,
      viewer: { id: sessionUser.id, isAdmin, roles: userRoles },
    });
    dataset = result.dataset;
    provenance = result.provenance;
  } catch (err) {
    console.error("[story] runReportWithProof failed:", err);
  }

  return (
    <StoryViewer
      report={report}
      reportDbId={row.id}
      dataset={dataset as any}
      provenance={provenance as any}
      params={pvals}
      tenantCurrency={(tenant as any)?.currency ?? null}
    />
  );
}
