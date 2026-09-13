/**
 * Dashboard kiosk-token mint & list endpoints.
 *
 * POST /api/dashboards/[id]/kiosk-tokens — admin mints a new long random
 *      token. Returns the cleartext token EXACTLY ONCE — the client is
 *      expected to copy it immediately, since we only store it server-side
 *      for matching future requests.
 *
 * GET  /api/dashboards/[id]/kiosk-tokens — list active (non-revoked) tokens
 *      for this dashboard. Token values are NOT returned again, only their
 *      label / expiresAt / lastUsedAt for the manage UI.
 *
 * Tokens are intentionally ~256 bits of entropy: 32 bytes from
 * crypto.randomBytes encoded as base64url (43 chars). That's
 * brute-force-infeasible even at unlimited request rates, so we don't need
 * rate-limiting on the kiosk landing page.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { featureGate } from "@/lib/featureGate";

const MintSchema = z.object({
  // Optional human label so admins can tell tokens apart in the manage UI.
  // (e.g. "Hallway TV", "Sales floor monitor".)
  label: z.string().min(1).max(80).optional(),
  // Optional ISO-8601 expiry. When omitted, the token never expires (the
  // admin can still revoke explicitly via DELETE).
  expiresAt: z.string().datetime().optional(),
});

/** 32 bytes → 43 chars base64url. Cryptographically safe; URL-safe. */
function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  // Kiosk tokens require Business — they're how we segment the "wall display"
  // use case from the per-seat plan. Tenant viewers are still free to view a
  // dashboard inside the app on Team; what Business unlocks is a token URL
  // that bypasses login entirely.
  const blocked = await featureGate(user, "dashboard.kiosk_token");
  if (blocked) return blocked;

  const dashboard = await prisma.dashboard.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true, name: true, slug: true },
  });
  if (!dashboard) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const parsed = MintSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  const token = generateToken();
  const created = await prisma.dashboardKioskToken.create({
    data: {
      tenantId: user.tenantId,
      dashboardId: dashboard.id,
      token,
      label: parsed.data.label ?? null,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      createdById: user.id,
    },
  });
  recordAudit({
    user, kind: "dashboard.kiosk_token.mint", target: created.id, req,
    meta: {
      dashboardId: dashboard.id,
      dashboardName: dashboard.name,
      label: parsed.data.label ?? null,
      expiresAt: parsed.data.expiresAt ?? null,
    },
  });
  // Cleartext token returned EXACTLY ONCE. The client should copy it now —
  // there's no recovery if they navigate away without saving the URL.
  return NextResponse.json({
    id: created.id,
    token,
    label: created.label,
    expiresAt: created.expiresAt,
    kioskUrl: `/dashboards/${dashboard.slug}/kiosk?token=${token}`,
  });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const dashboard = await prisma.dashboard.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true },
  });
  if (!dashboard) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const tokens = await prisma.dashboardKioskToken.findMany({
    where: { dashboardId: dashboard.id, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, expiresAt: true, lastUsedAt: true, createdAt: true },
  });
  return NextResponse.json({ items: tokens });
}
