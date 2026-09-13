/**
 * /api/admin/webhook-deliveries — recent delivery attempts for the
 * webhooks panel "Recent deliveries" expander.
 *
 * Filterable by webhookId so the panel can show one webhook's history
 * without scrolling through everyone else's noise.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const webhookId = url.searchParams.get("webhookId");
  const take = Math.min(200, Math.max(1, Number(url.searchParams.get("take") ?? 50)));

  const where: any = { tenantId: user.tenantId };
  if (webhookId) where.webhookId = webhookId;

  let items: any[] = [];
  try {
    items = await prisma.webhookDelivery.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      include: { webhook: { select: { name: true } } },
    });
  } catch { /* table missing */ }

  return NextResponse.json({
    items: items.map((d) => ({
      id: d.id,
      webhookId: d.webhookId,
      webhookName: d.webhook?.name ?? "(deleted)",
      event: d.event,
      status: d.status,
      responseCode: d.responseCode,
      responseBody: d.responseBody,
      errorMessage: d.errorMessage,
      durationMs: d.durationMs,
      attempt: d.attempt,
      createdAt: d.createdAt,
    })),
  });
}
