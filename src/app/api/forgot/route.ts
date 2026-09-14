import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ensureLimit } from "@/lib/rateLimit";
import { clientIp } from "@/lib/security/clientIp";

/**
 * POST /api/forgot — start a password reset.
 *
 * Never leaks whether an email exists: always returns 200. For real emails we
 * mint a 60-minute single-use token, hash it (SHA-256) for storage, and hand
 * the raw token off to the email dispatcher. The reset URL carries the raw
 * token; `/api/reset` re-hashes and compares.
 *
 * Rate-limited in-app by both IP (abuse from one source) and target email
 * (so an attacker can't inbox-bomb a specific victim by spraying from many
 * IPs) — do not rely on outer infra alone.
 */

export const dynamic = "force-dynamic";

const Schema = z.object({ email: z.string().email() });

function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const limited = ensureLimit("forgot", `ip:${ip}`, 10, 5 * 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    // Still 200 to not leak existence - bad format just returns the success shape.
    return NextResponse.json({ ok: true });
  }

  const emailLimited = ensureLimit("forgot-email", `email:${parsed.data.email.toLowerCase()}`, 3, 15 * 60_000);
  if (emailLimited) return NextResponse.json({ ok: true }); // still don't leak existence

  // email is globally unique now — deterministic, not "whichever row
  // findFirst happens to hit first" across a user's several workspaces.
  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: { id: true, email: true, name: true },
  });

  if (user) {
    // PasswordResetToken still hangs off one tenantId (it's an audit
    // convenience column, not a scoping mechanism here — the token itself
    // resets the one global passwordHash, valid for every workspace this
    // email belongs to). Any membership works; pick the oldest.
    const membership = await prisma.membership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      select: { tenantId: true },
    });
    if (!membership) return NextResponse.json({ ok: true }); // account belongs to no workspace — nothing to reset into

    const raw = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.passwordResetToken.create({
      data: {
        tenantId: membership.tenantId,
        userId: user.id,
        tokenHash: hashToken(raw),
        expiresAt,
      },
    });

    // Send the email. Uses the same SMTP path as scheduled delivery; if SMTP
    // isn't configured we log the link so dev admins can still see it.
    const origin = new URL(req.url).origin;
    const resetUrl = `${origin}/reset/${raw}`;
    try {
      const mod = await import("@/lib/delivery/dispatch");
      // Reuse the email path by hand-crafting a Rendered-like payload. If
      // nodemailer isn't installed or SMTP isn't set, this becomes "skipped"
      // and the link still gets logged below for dev visibility.
      await mod.dispatchDelivery(
        {
          kind: "email",
          recipients: [user.email],
          subject: "Reset your Curf password",
        },
        {
          body: Buffer.from(
            `Hello${user.name ? " " + user.name : ""},\n\n` +
            `You (or someone claiming to be you) asked to reset your Curf password.\n\n` +
            `Follow this link within 60 minutes:\n${resetUrl}\n\n` +
            `If you didn't make this request, you can ignore this email.\n`,
            "utf8"
          ),
          filename: "reset-link.txt",
          contentType: "text/plain",
          reportName: "Password reset",
          reportId: "password-reset",
          origin,
        }
      );
    } catch {
      // Don't break the flow if email fails; dev admins can watch server logs.
    }
    if (process.env.NODE_ENV !== "production") {
      console.log(`[password-reset] dev link for ${user.email}: ${resetUrl}`);
    }
  }

  return NextResponse.json({ ok: true });
}
