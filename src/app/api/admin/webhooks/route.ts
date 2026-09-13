/**
 * /api/admin/webhooks
 *   GET  — list webhooks for this tenant + the event registry for the picker
 *   POST — create a new webhook (admin only)
 *
 * Per-row management lives at /[id]/route.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { generateSigningSecret, EVENT_REGISTRY, knownEventIds } from "@/lib/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function safeProject(w: any) {
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    events: w.events ? w.events.split(",").map((s: string) => s.trim()).filter(Boolean) : [],
    enabled: w.enabled,
    lastFiredAt: w.lastFiredAt,
    lastStatus: w.lastStatus,
    lastError: w.lastError,
    payloadFormat: w.payloadFormat ?? "auto",
    // Show only first 8 chars of the secret so the admin can identify
    // the row after rotation without exposing the full key.
    signingSecretPreview: w.signingSecret ? w.signingSecret.slice(0, 8) + "…" : null,
    createdAt: w.createdAt,
  };
}

export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  let items: any[] = [];
  let migrationNeeded = false;
  try {
    items = await prisma.webhook.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
    });
  } catch {
    migrationNeeded = true;
  }
  return NextResponse.json({
    items: items.map(safeProject),
    eventRegistry: EVENT_REGISTRY,
    migrationNeeded,
  });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url().refine((u) => /^https?:\/\//i.test(u), "URL must start with http:// or https://"),
  events: z.array(z.string()).min(1).max(50),
  payloadFormat: z.enum(["auto", "raw", "slack", "teams", "discord"]).optional().default("auto"),
});

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  const validEvents = parsed.data.events.filter((e) => knownEventIds().includes(e));
  if (validEvents.length === 0) {
    return NextResponse.json({ error: "No recognised events selected." }, { status: 400 });
  }

  const signingSecret = generateSigningSecret();
  const created = await prisma.webhook.create({
    data: {
      tenantId: user.tenantId,
      name: parsed.data.name.trim(),
      url: parsed.data.url.trim(),
      events: validEvents.join(","),
      signingSecret,
      payloadFormat: parsed.data.payloadFormat ?? "auto",
      enabled: true,
      createdById: user.id,
    },
  });

  recordAudit({ user, kind: "webhook.create", target: created.id, req, meta: { name: created.name, eventCount: validEvents.length } });
  return NextResponse.json({
    webhook: safeProject(created),
    // ONE-time secret reveal so the admin can paste it into the recipient's
    // verification config. After this response the secret is masked forever
    // (re-rotate to get a new one).
    signingSecretOnce: signingSecret,
  });
}
