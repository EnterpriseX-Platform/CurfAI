/**
 * /api/admin/webhooks/[id]
 *   POST { action: "toggle" | "test" | "rotate" | "events", events?: string[] }
 *   DELETE — remove the webhook (deliveries cascade)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { generateSigningSecret, getEvent, knownEventIds, testDeliver } from "@/lib/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ActionSchema = z.object({
  action: z.enum(["toggle", "test", "rotate", "events", "format"]),
  events: z.array(z.string()).optional(),
  testEvent: z.string().optional(),
  payloadFormat: z.enum(["auto", "raw", "slack", "teams", "discord"]).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const wh = await prisma.webhook.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!wh) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  if (parsed.data.action === "toggle") {
    const updated = await prisma.webhook.update({
      where: { id: wh.id },
      data: { enabled: !wh.enabled },
    });
    recordAudit({ user, kind: "webhook.toggle", target: wh.id, req, meta: { enabled: updated.enabled } });
    return NextResponse.json({ ok: true, enabled: updated.enabled });
  }

  if (parsed.data.action === "rotate") {
    const next = generateSigningSecret();
    await prisma.webhook.update({ where: { id: wh.id }, data: { signingSecret: next } });
    recordAudit({ user, kind: "webhook.rotate", target: wh.id, req });
    // ONE-time secret reveal — same pattern as create.
    return NextResponse.json({ ok: true, signingSecretOnce: next });
  }

  if (parsed.data.action === "events") {
    const events = (parsed.data.events ?? []).filter((e) => knownEventIds().includes(e));
    if (events.length === 0) return NextResponse.json({ error: "No recognised events selected." }, { status: 400 });
    const updated = await prisma.webhook.update({
      where: { id: wh.id },
      data: { events: events.join(",") },
    });
    recordAudit({ user, kind: "webhook.events.update", target: wh.id, req, meta: { eventCount: events.length } });
    return NextResponse.json({ ok: true, events });
  }

  if (parsed.data.action === "format") {
    const fmt = parsed.data.payloadFormat ?? "auto";
    await prisma.webhook.update({
      where: { id: wh.id },
      data: { payloadFormat: fmt },
    });
    recordAudit({ user, kind: "webhook.format.update", target: wh.id, req, meta: { payloadFormat: fmt } });
    return NextResponse.json({ ok: true, payloadFormat: fmt });
  }

  // test
  const eventId = parsed.data.testEvent ?? wh.events.split(",")[0]?.trim();
  if (!eventId) return NextResponse.json({ error: "Webhook has no events configured." }, { status: 400 });
  const ev = getEvent(eventId);
  if (!ev) return NextResponse.json({ error: `Unknown event: ${eventId}` }, { status: 400 });
  const result = await testDeliver({
    tenantId: user.tenantId,
    webhookId: wh.id,
    url: wh.url,
    signingSecret: wh.signingSecret,
    event: eventId,
    data: ev.samplePayload,
    payloadFormat: wh.payloadFormat,
  });
  recordAudit({ user, kind: "webhook.test", target: wh.id, req, meta: { event: eventId, status: result.status, code: result.responseCode } });
  return NextResponse.json({ result });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const wh = await prisma.webhook.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!wh) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.webhook.delete({ where: { id: wh.id } });
  recordAudit({ user, kind: "webhook.delete", target: wh.id, req, meta: { name: wh.name } });
  return NextResponse.json({ ok: true });
}
