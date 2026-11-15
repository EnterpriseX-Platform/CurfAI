/**
 * POST /api/screen/pair { code } — a wall screen (no sign-in) trades a live
 * pairing code for its display's kiosk link. Unauthenticated by design: the
 * code IS the credential, so it is single use (claimed with one conditional
 * update, never read-then-write), short-lived, stored only as a hash, and
 * attempts are limited per address. Redeeming mints an ordinary kiosk token,
 * so an admin revokes a paired screen the way they revoke any other.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { withSystemDbContext } from "@/lib/dbContext";
import { recordAudit } from "@/lib/audit";
import { ensureLimit } from "@/lib/rateLimit";
import { tenantIsOpen } from "@/lib/tenantGuard";
import { clientIp } from "@/lib/security/clientIp";
import { normalizePairingCode, hashPairingCode } from "@/lib/onScreen/pairing";

const Body = z.object({ code: z.string().min(1).max(40) });

const NOT_VALID = { error: "That code is not valid or has expired." };

export async function POST(req: NextRequest) {
  const limited = await ensureLimit("screen-pair", clientIp(req), 10, 5 * 60_000);
  if (limited) return limited;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json(NOT_VALID, { status: 400 });
  const code = normalizePairingCode(parsed.data.code);
  if (!code) return NextResponse.json(NOT_VALID, { status: 400 });
  const codeHash = hashPairingCode(code);

  // A screen has no workspace to bind: the code is what says which one.
  return withSystemDbContext(async () => {
    const now = new Date();
    const claimed = await prisma.onScreenPairingCode.updateMany({
      where: { codeHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return NextResponse.json(NOT_VALID, { status: 400 });

    const row = await prisma.onScreenPairingCode.findUnique({
      where: { codeHash },
      select: { id: true, tenantId: true, createdById: true, onScreen: { select: { id: true, name: true, slug: true } } },
    });
    if (!row?.onScreen) return NextResponse.json(NOT_VALID, { status: 400 });
    // A closed workspace's code is as dead as an expired one: no kiosk token is minted for it.
    if (!(await tenantIsOpen(row.tenantId))) return NextResponse.json(NOT_VALID, { status: 400 });

    const token = randomBytes(32).toString("base64url");
    const created = await prisma.onScreenDisplayKioskToken.create({
      data: { tenantId: row.tenantId, onScreenId: row.onScreen.id, token, label: "Paired screen", createdById: row.createdById },
      select: { id: true },
    });
    recordAudit({
      tenantId: row.tenantId, kind: "onScreen.pairing_code.redeem", target: created.id, req,
      meta: { onScreenId: row.onScreen.id, onScreenName: row.onScreen.name, pairingCodeId: row.id },
    });
    return NextResponse.json({ kioskUrl: `/on-screen/${row.onScreen.slug}/kiosk?token=${token}` });
  });
}
