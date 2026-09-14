import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { ensureLimit } from "@/lib/rateLimit";
import { clientIp } from "@/lib/security/clientIp";

export const dynamic = "force-dynamic";

const Schema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8).max(200),
});

function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const limited = ensureLimit("reset", `ip:${ip}`, 10, 5 * 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const tokenHash = hashToken(parsed.data.token);
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });
  if (!row || row.usedAt || row.expiresAt < new Date()) {
    return NextResponse.json({ error: "Reset link is invalid or has expired" }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const target = await prisma.user.update({
    where: { id: row.userId },
    data: { passwordHash },
    select: { id: true, email: true },
  });
  await prisma.passwordResetToken.update({
    where: { id: row.id },
    data: { usedAt: new Date() },
  });

  // One passwordHash change takes effect for every workspace this email
  // belongs to — audit it against each one, not just PasswordResetToken's
  // own (arbitrary "pick one") tenantId.
  const memberships = await prisma.membership.findMany({
    where: { userId: target.id },
    select: { tenantId: true },
  });
  for (const m of memberships) {
    recordAudit({
      tenantId: m.tenantId,
      userId: target.id,
      userEmail: target.email,
      kind: "password.reset.complete",
      target: target.id,
      req,
      meta: { tokenId: row.id },
    });
  }

  return NextResponse.json({ ok: true });
}
