import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/billing/status
 *
 * Just enough for the global past-due banner (components/layout/PastDueBanner.tsx,
 * mounted from AppShell on every page for admins) to decide whether to show
 * itself — not the full billing page's data. Any signed-in member of the
 * tenant can call it (read-only, no card data, nothing an admin's teammate
 * shouldn't see); the banner itself only renders for admins since they're
 * the ones who can act on it.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let tenant: { stripeStatus: string | null; stripeCurrentPeriodEnd: Date | null } | null = null;
  try {
    tenant = await prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { stripeStatus: true, stripeCurrentPeriodEnd: true },
    });
  } catch (e: any) {
    console.warn("[billing/status] query failed:", e?.message ?? e);
  }

  return NextResponse.json({
    pastDue: tenant?.stripeStatus === "past_due",
    periodEnd: tenant?.stripeCurrentPeriodEnd ?? null,
  });
}
