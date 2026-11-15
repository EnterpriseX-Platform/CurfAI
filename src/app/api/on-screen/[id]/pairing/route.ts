/**
 * POST /api/on-screen/:id/pairing — an admin asks for a pairing code for one
 * display. The code is returned once; only its hash is stored. A wall screen
 * trades it for the display's kiosk link at /screen (POST /api/screen/pair).
 * Same tier gate as minting a kiosk token: it is the same capability.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { featureGate } from "@/lib/featureGate";
import { generatePairingCode, hashPairingCode, displayPairingCode, PAIRING_TTL_MS } from "@/lib/onScreen/pairing";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const blocked = await featureGate(user, "dashboard.kiosk_token");
  if (blocked) return blocked;

  const onScreen = await prisma.onScreenDisplay.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true, name: true },
  });
  if (!onScreen) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  const created = await prisma.onScreenPairingCode.create({
    data: { tenantId: user.tenantId, onScreenId: onScreen.id, codeHash: hashPairingCode(code), expiresAt, createdById: user.id },
    select: { id: true },
  });
  recordAudit({ user, kind: "onScreen.pairing_code.create", target: created.id, req, meta: { onScreenId: onScreen.id, onScreenName: onScreen.name } });
  return NextResponse.json({ code: displayPairingCode(code), expiresAt });
}
