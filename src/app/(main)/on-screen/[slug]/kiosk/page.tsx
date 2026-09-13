import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { DashboardViewer } from "@/app/(main)/dashboards/[slug]/DashboardViewer";
import { prefetchDashboardPayload } from "@/app/(main)/dashboards/[slug]/payload";

/**
 * Unauthenticated kiosk viewer for On Screen displays. Mirrors
 * /dashboards/[slug]/kiosk/page.tsx exactly — see that file's docstring for
 * the token/ACL rationale (token possession IS the authorization; visibility
 * ACL is intentionally not re-checked here).
 */
export const dynamic = "force-dynamic";

export default async function OnScreenKioskPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { token?: string };
}) {
  const token = searchParams?.token?.trim();
  if (!token) return <KioskExpired reason="Missing kiosk token. Open this display from /on-screen instead." />;

  const tokenRow = await prisma.onScreenDisplayKioskToken.findUnique({
    where: { token },
    include: { onScreen: true },
  });
  if (!tokenRow) return <KioskExpired reason="Kiosk token not recognised." />;
  if (tokenRow.revokedAt) return <KioskExpired reason="This kiosk token has been revoked." />;
  if (tokenRow.expiresAt && new Date(tokenRow.expiresAt) < new Date()) {
    return <KioskExpired reason={`This kiosk token expired on ${new Date(tokenRow.expiresAt).toLocaleDateString()}.`} />;
  }
  if (tokenRow.onScreen?.slug !== params.slug) notFound();

  void prisma.onScreenDisplayKioskToken
    .update({ where: { id: tokenRow.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  const payload = await prefetchDashboardPayload(tokenRow.onScreen);
  return <DashboardViewer dashboard={{ ...payload, interactive: false }} hideExit />;
}

function KioskExpired({ reason }: { reason: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-foreground px-6 text-background">
      <div className="text-center">
        <p className="text-sm font-medium">Kiosk display unavailable</p>
        <p className="mt-1 text-xs text-faint">{reason}</p>
      </div>
    </div>
  );
}
