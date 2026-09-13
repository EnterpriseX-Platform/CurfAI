/**
 * /api/admin/scim/tokens — mint SCIM bearer tokens.
 *
 * Admin-only. The mint format is `cscim_<random>_<secret>`. We hash
 * the secret with bcrypt and store only the prefix verbatim — the
 * full token is shown to the admin once at mint time.
 *
 * SCIM tokens reuse the ApiKey model with scope='scim' so revocation
 * + last-used tracking + listing work with the existing admin UI for
 * free.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { featureGate } from "@/lib/featureGate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  name: z.string().min(1).max(80),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const items = await prisma.apiKey
    .findMany({
      where: { tenantId: user.tenantId, scope: "scim" },
      select: { id: true, name: true, prefix: true, lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    })
    .catch(() => []);

  return NextResponse.json({
    items: items.map((k: any) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
      createdAt: k.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;
  const block = await featureGate(user, "gov.scim");
  if (block) return block;

  const body = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }

  // Token shape: cscim_<8-byte-hex>_<32-byte-hex>. We separate prefix
  // and secret with the LAST underscore at auth time, so the prefix
  // can keep the leading underscore in `cscim_xxxxxxxx`.
  const prefixSuffix = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const prefix = `cscim_${prefixSuffix}`;
  const fullToken = `${prefix}_${secret}`;
  const hashedSecret = await bcrypt.hash(secret, 10);

  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const created = await prisma.apiKey.create({
    data: {
      tenantId: user.tenantId,
      name: parsed.data.name.trim(),
      prefix,
      hashedSecret,
      role: "admin", // SCIM operations are administrative — write-side
      scope: "scim",
      expiresAt,
      createdById: user.id,
    },
    select: { id: true, name: true, prefix: true, expiresAt: true, createdAt: true },
  });

  recordAudit({
    user, kind: "scim.token.create", target: created.id, req,
    meta: { name: created.name, expiresAt: created.expiresAt ? new Date(created.expiresAt).toISOString() : null },
  });

  return NextResponse.json({
    token: created,
    // ONE-time secret reveal. The admin pastes this into the IdP's
    // "Bearer token" config field; it's never recoverable after this
    // response.
    fullTokenOnce: fullToken,
  });
}
