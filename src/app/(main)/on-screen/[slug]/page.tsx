import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSession, getUserRoles } from "@/lib/auth";
import { canSeeDataSource } from "@/lib/datasourceAcl";
import { DashboardViewer } from "@/app/(main)/dashboards/[slug]/DashboardViewer";
import { prefetchDashboardPayload } from "@/app/(main)/dashboards/[slug]/payload";

/**
 * Logged-in On Screen viewer. Reuses DashboardViewer + prefetchDashboardPayload
 * as-is — OnScreenDisplay rows carry the exact same rotation/report/layout
 * shape Dashboard does, so there's no separate rendering pipeline to
 * maintain. The one difference: `interactive` is force-set to `false` here
 * rather than read off the row, because an OnScreenDisplay has no such
 * column — it is non-interactive by construction, not by per-row toggle
 * (that's the whole reason this is a separate model from Dashboard).
 *
 * The kiosk-token variant at /on-screen/[slug]/kiosk/page.tsx mirrors
 * /dashboards/[slug]/kiosk/page.tsx the same way.
 */
export const dynamic = "force-dynamic";

export default async function OnScreenPage({ params }: { params: { slug: string } }) {
  const session = await getSession();
  if (!session) redirect(`/login?callbackUrl=/on-screen/${encodeURIComponent(params.slug)}`);
  const user = session.user as any;

  const onScreen = await prisma.onScreenDisplay.findFirst({
    where: { tenantId: user.tenantId, slug: params.slug },
  });
  if (!onScreen) notFound();

  const userRoles = await getUserRoles();
  const isAdmin = user.role === "admin";
  if (!canSeeDataSource(onScreen, { id: user.id, isAdmin, roles: userRoles })) {
    notFound();
  }

  const payload = await prefetchDashboardPayload(onScreen);
  return <DashboardViewer dashboard={{ ...payload, interactive: false }} />;
}
