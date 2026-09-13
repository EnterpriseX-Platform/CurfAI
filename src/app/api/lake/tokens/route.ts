/**
 * /api/lake/tokens
 *   GET    — list tokens for the tenant (without secrets)
 *   POST   — mint a new token bound to one tableName
 *   DELETE /api/lake/tokens/[id] — revoke
 *
 * Token format: `lk_<8 hex>.<32 hex>` — the prefix is the lookup index,
 * the secret is hashed with SHA-256 before storage. Secret is shown to
 * the user once at mint time and never again.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const items = await prisma.lakeIngestToken.findMany({
    where: { tenantId: user.tenantId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, label: true, tableName: true, prefix: true,
      lastUsedAt: true, createdAt: true, revokedAt: true,
    },
  });
  return NextResponse.json({ items });
}

const CreateSchema = z.object({
  label: z.string().min(1).max(80),
  tableName: z.string().min(1).max(60),
});

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  const prefix = "lk_" + crypto.randomBytes(4).toString("hex");
  const secret = crypto.randomBytes(16).toString("hex");
  const hashed = crypto.createHash("sha256").update(secret).digest("hex");

  const row = await prisma.lakeIngestToken.create({
    data: {
      tenantId: user.tenantId,
      label: parsed.data.label,
      tableName: parsed.data.tableName,
      prefix,
      hashedSecret: hashed,
      createdById: user.id,
    },
  });

  recordAudit({
    user, kind: "lake.token.create", target: row.id, req,
    meta: { label: row.label, tableName: row.tableName },
  });

  // Return the raw secret ONCE. Caller surfaces it to the user with a
  // "you won't see this again" warning, same UX as ApiKey mint.
  return NextResponse.json({
    token: { id: row.id, label: row.label, tableName: row.tableName, prefix },
    secret: `${prefix}.${secret}`,
  });
}
