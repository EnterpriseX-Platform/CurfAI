/**
 * OnScreenDisplay kiosk-token mint & list endpoints. Mirrors
 * /api/dashboards/[id]/kiosk-tokens exactly (same token entropy, same
 * one-time cleartext-return contract, same Business-tier gate — see that
 * file's docstring).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { featureGate } from "@/lib/featureGate";

const MintSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  expiresAt: z.string().datetime().optional(),
});

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  // Same "wall display without login" tier gate as Dashboard kiosk tokens —
  // it's the same underlying capability, just against a different table.
  const blocked = await featureGate(user, "dashboard.kiosk_token");
  if (blocked) return blocked;

  const onScreen = await prisma.onScreenDisplay.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true, name: true, slug: true },
  });
  if (!onScreen) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const parsed = MintSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  const token = generateToken();
  const created = await prisma.onScreenDisplayKioskToken.create({
    data: {
      tenantId: user.tenantId,
      onScreenId: onScreen.id,
      token,
      label: parsed.data.label ?? null,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      createdById: user.id,
    },
  });
  recordAudit({
    user, kind: "onScreen.kiosk_token.mint", target: created.id, req,
    meta: {
      onScreenId: onScreen.id,
      onScreenName: onScreen.name,
      label: parsed.data.label ?? null,
      expiresAt: parsed.data.expiresAt ?? null,
    },
  });
  return NextResponse.json({
    id: created.id,
    token,
    label: created.label,
    expiresAt: created.expiresAt,
    kioskUrl: `/on-screen/${onScreen.slug}/kiosk?token=${token}`,
  });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const onScreen = await prisma.onScreenDisplay.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true },
  });
  if (!onScreen) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const tokens = await prisma.onScreenDisplayKioskToken.findMany({
    where: { onScreenId: onScreen.id, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, expiresAt: true, lastUsedAt: true, createdAt: true },
  });
  return NextResponse.json({ items: tokens });
}
