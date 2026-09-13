import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { isKnownCurrencyCode } from "@/lib/reporting/currency";
import { isKnownRegionCode } from "@/lib/tenantRegion";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const row = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    include: { _count: { select: { memberships: true, reports: true, dataSources: true } } },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    id: row.id,
    slug: row.slug,
    name: row.name,
    currency: (row as any).currency ?? null,
    region: (row as any).region ?? null,
    createdAt: row.createdAt,
    counts: {
      users: row._count.memberships,
      reports: row._count.reports,
      dataSources: row._count.dataSources,
    },
  });
}

const PatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  // Deliberately NOT gated by tier — unlike /api/admin/tenant/brand, this is
  // a correctness setting (seeing your own currency), not a paid brand
  // feature. Validated against the picker's shortlist; Intl accepts more
  // codes than this, but restricting to the curated list keeps the picker
  // and the stored value in sync.
  currency: z.string().length(3).refine(isKnownCurrencyCode, "Unknown currency code").optional(),
  // Self-declared jurisdiction — see lib/tenantRegion.ts. Same "not tier-
  // gated" reasoning as currency: this is a correctness/compliance setting,
  // not a paid brand feature.
  region: z.string().refine(isKnownRegionCode, "Unknown region code").optional(),
}).refine((v) => v.name !== undefined || v.currency !== undefined || v.region !== undefined, "No fields to update");

export async function PATCH(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }

  const data: Record<string, string> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.currency !== undefined) data.currency = parsed.data.currency.toUpperCase();
  if (parsed.data.region !== undefined) data.region = parsed.data.region.toLowerCase();

  const updated = await prisma.tenant.update({
    where: { id: user.tenantId },
    data,
  });
  recordAudit({
    user, kind: "tenant.update", target: user.tenantId, req,
    meta: data,
  });
  return NextResponse.json({
    id: updated.id, name: updated.name,
    currency: updated.currency ?? null,
    region: updated.region ?? null,
  });
}
