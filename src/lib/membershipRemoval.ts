/**
 * The record of a removal that was somebody's decision (an administrator removing a member, the company's SCIM taking the person
 * out), so that auto-join (a verified domain's sign-in joining its workspace, ee/identity/signin.ts) does not undo it at the
 * person's next sign-in. A membership stays what it always was: a row that exists or does not, and access everywhere follows
 * that. Nothing but auto-join reads this.
 *
 * Writing it can never block the removal itself: a failure is logged and the removal goes ahead (the person could then be
 * joined again by auto-join, which is what happened before this record existed).
 */
import { prisma } from "@/lib/db";
import { withSystemDbContext } from "@/lib/dbContext";

export type RemovalSource = "scim" | "admin";

export async function recordMembershipRemoval(userId: string, tenantId: string, source: RemovalSource): Promise<void> {
  try {
    await withSystemDbContext(() => prisma.membershipRemoval.upsert({
      where: { userId_tenantId: { userId, tenantId } },
      create: { userId, tenantId, source },
      update: { source, removedAt: new Date() },
    }));
  } catch (e: any) {
    console.warn("[membership] could not record the removal:", e?.message ?? e);
  }
}

/** The organisation asked for the person again (SCIM provisioned them): auto-join may join them as it would anyone. */
export async function clearMembershipRemoval(userId: string, tenantId: string): Promise<void> {
  try {
    await withSystemDbContext(() => prisma.membershipRemoval.deleteMany({ where: { userId, tenantId } }));
  } catch (e: any) {
    console.warn("[membership] could not clear the removal record:", e?.message ?? e);
  }
}

export async function wasMembershipRemoved(userId: string, tenantId: string): Promise<boolean> {
  return withSystemDbContext(async () => !!(await prisma.membershipRemoval.findUnique({ where: { userId_tenantId: { userId, tenantId } }, select: { id: true } })));
}
