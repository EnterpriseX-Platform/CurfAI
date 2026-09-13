import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReport } from "@/lib/reporting/runner";
import { DesignerShell } from "./DesignerShell";
import { canBuild } from "@/lib/roles";

export const dynamic = "force-dynamic";

export default async function EditorPage({ params }: { params: { id: string } }) {
  const session = await getSession();
  const user = (session?.user as any) ?? null;
  if (!session) redirect("/login?callbackUrl=/reports/" + params.id + "/edit");

  // Designer is editor/admin only. Viewers bounce back to the read-only viewer.
  if (!canBuild(user.role)) {
    redirect("/reports/" + params.id);
  }

  const row = await prisma.report.findFirst({ where: { id: params.id, tenantId: user.tenantId } });
  if (!row) notFound();
  const report = ReportSchema.parse(JSON.parse(row.definition));

  // The canvas resolves theme + chart style from the report alone, so without
  // these the designer previews a report the viewer never renders: a workspace
  // on Enterprise/Boardroom was drawing classic indigo charts in the editor and
  // flat navy ones once published. Read-only here — the branding panel owns
  // these; the designer just needs the same fallbacks the viewer resolves with.
  const tenantRow = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { brandJson: true } as any,
  });
  let tenantBrand: { defaultTheme?: string; defaultChartStyle?: string; customPalette?: string[] } = {};
  try { tenantBrand = JSON.parse((tenantRow as any)?.brandJson || "{}"); } catch {}

  // Initial preview data: uses parameter defaults.
  const initialParams: Record<string, unknown> = {};
  for (const p of report.parameters) initialParams[p.name] = p.default ?? "";
  let initialDataset = {};
  try {
    initialDataset = await runReport({ report, params: initialParams });
  } catch {
    // Designer still works even if initial query fails - user may be wiring things up.
  }

  return (
    <DesignerShell
      reportId={row.id}
      initialReport={report}
      initialParams={initialParams}
      initialDataset={initialDataset}
      tenantBrand={tenantBrand}
    />
  );
}
