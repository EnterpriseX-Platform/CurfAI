import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin, MEMBERSHIP_ROLES } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { featureGate } from "@/lib/featureGate";
import { createApiKey } from "@/lib/apiKeys";

/**
 * Admin-only CRUD for API keys scoped to the current tenant.
 *
 *   GET    /api/admin/api-keys        - list keys (secrets never returned)
 *   POST   /api/admin/api-keys        - mint a new key; returns secret ONCE
 *   DELETE /api/admin/api-keys?id=... - revoke (soft delete)
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const rows = await prisma.apiKey.findMany({
    where: { tenantId: user.tenantId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, name: true, prefix: true, role: true,
      lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true,
      requestCount: true, scopedReportIds: true,
    },
  });
  return NextResponse.json({
    items: rows.map((r: any) => ({
      ...r,
      scopedReportIds: r.scopedReportIds ? JSON.parse(r.scopedReportIds) : null,
    })),
  });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  role: z.enum(MEMBERSHIP_ROLES).default("viewer"),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  /**
   * Embedded-analytics productization (Phase 3.2). Omitted/undefined =
   * full tenant access at `role`'s level, matching every key minted
   * before this field existed. A non-empty array restricts the key to
   * only those report ids — the shape a customer embedding one dashboard
   * headlessly actually needs, instead of a tenant-wide credential.
   */
  scopedReportIds: z.array(z.string()).max(50).optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;
  // API keys are a Growth-tier feature in the new pricing matrix
  // (gov.api_keys = "growth"). Routed through featureGate so the 402 body
  // names the feature explicitly.
  const block = await featureGate(user, "gov.api_keys");
  if (block) return block;

  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 3600 * 1000)
    : null;

  // Verify every scoped report id is real and actually in this tenant
  // before minting — a key scoped to a typo'd or cross-tenant id would
  // just silently see nothing, which reads as "broken," not "scoped."
  let scopedReportIds: string[] | undefined = parsed.data.scopedReportIds?.length ? parsed.data.scopedReportIds : undefined;
  if (scopedReportIds) {
    const found = await prisma.report.findMany({
      where: { id: { in: scopedReportIds }, tenantId: user.tenantId },
      select: { id: true },
    });
    const foundIds = new Set(found.map((r) => r.id));
    const missing = scopedReportIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return NextResponse.json({ error: `Report id(s) not found in this tenant: ${missing.join(", ")}` }, { status: 400 });
    }
  }

  const created = await createApiKey({
    tenantId: user.tenantId,
    name: parsed.data.name,
    role: parsed.data.role,
    createdById: user.id,
    expiresAt,
    scopedReportIds,
  });

  recordAudit({
    user, kind: "apikey.mint", target: created.id, req,
    meta: {
      name: parsed.data.name, role: parsed.data.role, prefix: created.prefix, expiresAt: expiresAt?.toISOString() ?? null,
      scopedReportCount: scopedReportIds?.length ?? 0,
    },
  });

  return NextResponse.json(created);
}

export async function DELETE(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const existing = await prisma.apiKey.findFirst({
    where: { id, tenantId: user.tenantId },
    select: { id: true, name: true, prefix: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.apiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  recordAudit({
    user, kind: "apikey.revoke", target: id, req,
    meta: { name: existing.name, prefix: existing.prefix },
  });

  return NextResponse.json({ ok: true });
}
