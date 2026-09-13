/**
 * POST /api/push/subscribe — register a Web Push subscription.
 * DELETE /api/push/subscribe?endpoint=... — remove a subscription.
 *
 * The browser hands us the endpoint URL + p256dh + auth keys after the
 * user grants notification permission. We persist a row scoped to the
 * (tenant, user) so dispatch knows where to push events.
 *
 * Re-subscribing with the same endpoint is a no-op (we upsert by
 * endpoint), so a "subscribe → permission denied → re-subscribe later"
 * flow doesn't accumulate stale rows.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  label: z.string().max(80).optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }

  // `endpoint` is globally unique. A plain upsert would let any user who
  // learns another user's endpoint URL reassign that subscription to
  // themselves (tenant/user takeover — the victim's device stops receiving
  // its notifications and starts receiving the attacker tenant's). Only the
  // current owner may update an existing endpoint; anyone else is rejected.
  const existing = await (prisma as any).pushSubscription.findUnique({
    where: { endpoint: parsed.data.endpoint },
    select: { id: true, userId: true },
  });
  if (existing && existing.userId !== user.id) {
    return NextResponse.json({ error: "This subscription endpoint is already registered." }, { status: 409 });
  }
  const upserted = await (prisma as any).pushSubscription.upsert({
    where: { endpoint: parsed.data.endpoint },
    update: {
      tenantId: user.tenantId,
      userId: user.id,
      p256dh: parsed.data.keys.p256dh,
      authSecret: parsed.data.keys.auth,
      label: parsed.data.label?.trim() || null,
      enabled: true,
      lastPushError: null,
    },
    create: {
      tenantId: user.tenantId,
      userId: user.id,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      authSecret: parsed.data.keys.auth,
      label: parsed.data.label?.trim() || null,
    },
    select: { id: true },
  });

  recordAudit({
    user, kind: "push.subscribe", target: upserted.id, req,
    meta: { label: parsed.data.label ?? null },
  });

  return NextResponse.json({ ok: true, subscriptionId: upserted.id });
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const endpoint = url.searchParams.get("endpoint");
  if (!endpoint) return NextResponse.json({ error: "endpoint query param required" }, { status: 400 });

  const r = await (prisma as any).pushSubscription.deleteMany({
    where: { endpoint, userId: user.id },
  });
  recordAudit({ user, kind: "push.unsubscribe", target: endpoint, req, meta: { rowsDeleted: r.count } });
  return NextResponse.json({ ok: true, rowsDeleted: r.count });
}
