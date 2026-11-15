import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withSystemDbContext } from "@/lib/dbContext";
import { recordAudit } from "@/lib/audit";
import { ensureLimit } from "@/lib/rateLimit";
import { clientIp } from "@/lib/security/clientIp";
import { consumeVerificationToken } from "@/lib/emailVerification";

/**
 * POST /api/verify-email — use the link mailed after signup.
 *
 * A POST from the page's button, never a GET on the link itself: mail
 * scanners and link previews open every URL in a message, and would use up a
 * single-use link before the person got to it.
 */

export const dynamic = "force-dynamic";

const Schema = z.object({ token: z.string().min(20).max(200) });

export async function POST(req: NextRequest) {
  const limited = await ensureLimit("verify-email", `ip:${clientIp(req)}`, 10, 5 * 60_000);
  if (limited) return limited;

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const out = await consumeVerificationToken(parsed.data.token);
  if (!out.ok) {
    return NextResponse.json({ error: "This link is invalid or has expired. Request a new one from the sign-in page." }, { status: 400 });
  }

  if (!out.alreadyVerified) {
    // One address, every workspace it belongs to — audit it against each.
    const memberships = await withSystemDbContext(() => prisma.membership.findMany({
      where: { userId: out.userId },
      select: { tenantId: true },
    }));
    for (const m of memberships) {
      recordAudit({
        tenantId: m.tenantId,
        userId: out.userId,
        userEmail: out.email,
        kind: "email.verified",
        target: out.userId,
        req,
        meta: { via: "link" },
      });
    }
  }
  return NextResponse.json({ ok: true });
}
