import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSession, getUserRoles } from "@/lib/auth";
import { canSeeDataSource } from "@/lib/datasourceAcl";
import { DashboardViewer } from "./DashboardViewer";
import { prefetchDashboardPayload } from "./payload";

/**
 * Logged-in dashboard viewer. Pre-fetches every report's dataset server-side
 * and ships them to the client viewer as a single payload — that way the
 * rotation transitions are instant (no per-rotation network round-trip) and
 * the data is consistent across the whole rotation cycle.
 *
 * The kiosk-token variant at /dashboards/[slug]/kiosk/page.tsx wraps the
 * same DashboardViewer client component but skips the NextAuth check in
 * favour of a token lookup. Both share `prefetchDashboardPayload` below.
 */
export const dynamic = "force-dynamic";

export default async function DashboardPage({ params }: { params: { slug: string } }) {
  const session = await getSession();
  if (!session) redirect(`/login?callbackUrl=/dashboards/${encodeURIComponent(params.slug)}`);
  const user = session.user as any;

  const dashboard = await prisma.dashboard.findFirst({
    where: { tenantId: user.tenantId, slug: params.slug },
  });
  // A bare "This page could not be found" is jarring mid-browse — the most
  // common way to land here is switching workspaces while the URL still
  // points at a dashboard slug that belonged to the tenant you just left,
  // not a genuinely dead link. Bounce to the dashboard hub they DO have
  // instead (same for the visibility-ACL miss just below).
  if (!dashboard) redirect("/dashboards");

  // Visibility ACL — same gate as the listing API.
  const userRoles = await getUserRoles();
  const isAdmin = user.role === "admin";
  if (!canSeeDataSource(dashboard, { id: user.id, isAdmin, roles: userRoles })) {
    redirect("/dashboards");
  }

  const payload = await prefetchDashboardPayload(dashboard);
  return <DashboardViewer dashboard={payload} isAdmin={isAdmin} />;
}
