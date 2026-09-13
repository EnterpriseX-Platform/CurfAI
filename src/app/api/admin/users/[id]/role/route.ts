import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin, MEMBERSHIP_ROLES } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

/**
 * PATCH /api/admin/users/:id/role
 * Body: { authRole: "admin" | "developer" | "executive" | "viewer", resetPassword?: string }
 *
 * Admin-only. Updates a user's auth role inside the caller's tenant (the
 * Membership row for this workspace — role is per-workspace, a user can be
 * admin in one and viewer in another). The optional resetPassword sets a
 * fresh bcrypt hash on the (global) account so the admin can hand the user
 * a usable password without bouncing through the email reset flow — this
 * changes their login for every workspace they belong to, not just this one.
 *
 * This is the missing knob from /api/admin/users/[id] - that endpoint only
 * touches custom roles (rolesJson). This one updates the auth-tier role
 * that drives sidebar gating, edit-page redirects, and tier checks.
 */

const Schema = z.object({
  authRole: z.enum(MEMBERSHIP_ROLES),
  resetPassword: z.string().min(8).max(200).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }

  // Tenant-scope the target so cross-tenant ids can't escalate.
  const target = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: params.id, tenantId: user.tenantId } },
    include: { user: { select: { email: true } } },
  });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.membership.update({
    where: { userId_tenantId: { userId: params.id, tenantId: user.tenantId } },
    data: { role: parsed.data.authRole },
  });
  if (parsed.data.resetPassword) {
    await prisma.user.update({
      where: { id: params.id },
      data: { passwordHash: await bcrypt.hash(parsed.data.resetPassword, 10) },
    });
  }

  recordAudit({
    user, kind: "user.update", target: params.id, req,
    meta: {
      targetEmail: target.user.email,
      previousRole: target.role,
      newRole: parsed.data.authRole,
      passwordReset: Boolean(parsed.data.resetPassword),
    },
  });

  return NextResponse.json({ ok: true, id: params.id, role: parsed.data.authRole });
}
