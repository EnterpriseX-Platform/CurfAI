import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { DashboardViewer } from "../DashboardViewer";
import { prefetchDashboardPayload } from "../payload";

/**
 * Unauthenticated kiosk viewer. Same UX as /dashboards/[slug] but the auth
 * gate is the long random token in the query string instead of a NextAuth
 * session. Designed for hallway TVs / wall displays / unattended monitors —
 * paste the kiosk URL into a Chromium kiosk-mode browser and it cycles
 * forever.
 *
 * Tokens are minted via /api/dashboards/[id]/kiosk-tokens (admin only) and
 * tied to ONE dashboard — the slug in the URL must match the token's
 * dashboard or the request is rejected. Revoking a token invalidates the
 * URL immediately (the next page load fails the lookup).
 *
 * Visibility ACL is intentionally NOT applied here — token possession IS
 * the authorization. The admin who minted the token chose which dashboard
 * to expose; if the dashboard is "Just me" (owner_only), minting a kiosk
 * token still grants kiosk read because that's what the admin asked for.
 */
export const dynamic = "force-dynamic";

export default async function DashboardKioskPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { token?: string };
}) {
  const token = searchParams?.token?.trim();
  if (!token) return <KioskExpired reason="Missing kiosk token. Open this dashboard from /dashboards instead." />;

  const tokenRow = await prisma.dashboardKioskToken.findUnique({
    where: { token },
    include: { dashboard: true },
  });
  if (!tokenRow) return <KioskExpired reason="Kiosk token not recognised." />;
  if (tokenRow.revokedAt) return <KioskExpired reason="This kiosk token has been revoked." />;
  if (tokenRow.expiresAt && new Date(tokenRow.expiresAt) < new Date()) {
    return <KioskExpired reason={`This kiosk token expired on ${new Date(tokenRow.expiresAt).toLocaleDateString()}.`} />;
  }
  // Slug mismatch is a 404, not an error — protects against URL tampering
  // where someone tries to use a token from one dashboard to view another.
  if (tokenRow.dashboard?.slug !== params.slug) notFound();

  // Stamp last-used so the manage UI can show "Hallway TV — last used 2 min ago".
  // Best-effort: failure here doesn't block rendering.
  void prisma.dashboardKioskToken
    .update({ where: { id: tokenRow.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  const payload = await prefetchDashboardPayload(tokenRow.dashboard);
  return <DashboardViewer dashboard={payload} hideExit />;
}

function KioskExpired({ reason }: { reason: string }) {
  // Plain HTML — we don't want any AppShell or login UI flashing on a TV.
  return (
    <div className="grid min-h-screen place-items-center bg-foreground px-6 text-background">
      <div className="text-center">
        <p className="text-sm font-medium">Kiosk display unavailable</p>
        <p className="mt-1 text-xs text-faint">{reason}</p>
      </div>
    </div>
  );
}
