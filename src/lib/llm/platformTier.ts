/**
 * Changing which model a subscription tier runs on moves every workspace on that tier at once, so with two or more platform
 * operators a change waits for one other than the proposer to approve it (PlatformModelChange). With a single operator
 * there is nobody to wait for and the change applies at once, as before. The rules are pure; the writes are in
 * proposeTierModel / decideTierChange, which run under the caller's withSystemDbContext.
 */
import { prisma } from "@/lib/db";
import { clearPlatformModelCache } from "@/lib/llm/platformModels";

export type ChangeAction = "approve" | "reject" | "cancel";

/** Who may take which action on a pending change: another operator approves or rejects, the proposer may only withdraw. */
export function mayDecide(action: ChangeAction, proposedBy: string, operator: string): boolean {
  const same = proposedBy.trim().toLowerCase() === operator.trim().toLowerCase();
  return action === "cancel" ? same : !same;
}

/** Point a tier at a model (null = the env model). False when the model does not exist. */
export async function applyTierModel(tier: string, platformModelId: string | null): Promise<boolean> {
  if (!platformModelId) { await prisma.platformTierModel.deleteMany({ where: { tier } }); clearPlatformModelCache(); return true; }
  if (!(await prisma.platformModel.findUnique({ where: { id: platformModelId }, select: { id: true } }))) return false;
  await prisma.platformTierModel.upsert({ where: { tier }, create: { tier, platformModelId }, update: { platformModelId } });
  clearPlatformModelCache();
  return true;
}

/** A newer proposal for a tier replaces the one still waiting. */
export async function queueTierChange(tier: string, platformModelId: string | null, proposedBy: string) {
  await prisma.platformModelChange.updateMany({ where: { tier, status: "pending" }, data: { status: "cancelled", decidedBy: proposedBy, decidedAt: new Date() } });
  return prisma.platformModelChange.create({ data: { tier, platformModelId, proposedBy } });
}

export type DecideResult = { ok: true; status: "approved" | "rejected" | "cancelled" } | { ok: false; code: 404 | 403 | 409; error: string };

export async function decideTierChange(id: string, action: ChangeAction, operator: string): Promise<DecideResult> {
  const change = await prisma.platformModelChange.findUnique({ where: { id } });
  if (!change) return { ok: false, code: 404, error: "No such change" };
  if (change.status !== "pending") return { ok: false, code: 409, error: "Already decided" };
  if (!mayDecide(action, change.proposedBy, operator)) {
    return { ok: false, code: 403, error: action === "cancel" ? "Only the proposer can withdraw it" : "A second operator has to decide this" };
  }
  if (action === "approve" && !(await applyTierModel(change.tier, change.platformModelId))) {
    return { ok: false, code: 409, error: "That model no longer exists" };
  }
  const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "cancelled";
  await prisma.platformModelChange.update({ where: { id }, data: { status, decidedBy: operator, decidedAt: new Date() } });
  return { ok: true, status };
}
