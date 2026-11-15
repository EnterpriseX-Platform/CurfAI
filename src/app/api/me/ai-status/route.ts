/**
 * GET /api/me/ai-status — what the signed-in person needs to know about Curf's AI before they spend from it: whether
 * their workspace's calls are metered, how many of this month's credits are left, and whether the model is a trial one
 * (a platform admin's label on the model, see lib/llm/platformModels.ts). Any role may read it; it carries nothing about
 * the model's host or key. A workspace on its own key is never metered, so it gets `metered: false`.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { aiCreditStatus } from "@/lib/billing";
import { UPGRADE_URL } from "@/lib/plans";
import { getLlmCredentials } from "@/lib/llm/credentials";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const creds = await getLlmCredentials(user.tenantId).catch(() => null);
  if (!creds || creds.source !== "env") return NextResponse.json({ metered: false, trial: false });
  const status = await aiCreditStatus(user.tenantId).catch(() => null);
  if (!status || !Number.isFinite(status.allowance)) return NextResponse.json({ metered: false, trial: !!creds.trial });
  return NextResponse.json({
    metered: true,
    trial: !!creds.trial,
    allowance: status.allowance,
    used: status.used,
    remaining: status.remaining,
    resetsAt: status.resetsAt,
    upgradeUrl: UPGRADE_URL,
  });
}
