import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

/**
 * POST /api/admin/dev/bump-tier
 *
 * Dev-only one-shot to upgrade the calling tenant's tier without going
 * through Stripe. The admin-tenant PATCH endpoint deliberately does NOT
 * accept tier (real upgrades come from Stripe webhooks); this gives
 * pitch demos a quick local override.
 *
 * Production builds reject this route. Admin-gated to be safe.
 */

const Schema = z.object({ tier: z.enum(["community", "growth", "business", "enterprise"]) });

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 403 });
  }
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }

  await prisma.tenant.update({
    where: { id: user.tenantId },
    data: { tier: parsed.data.tier },
  });

  recordAudit({
    user, kind: "dev.bump-tier", target: user.tenantId, req,
    meta: { tier: parsed.data.tier },
  });

  return NextResponse.json({ ok: true, tier: parsed.data.tier });
}
