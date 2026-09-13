import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only convenience endpoint for testing visibility / RBAC behaviour.
 * Creates (or updates) a User row in the caller's tenant with a known
 * password and role list. Idempotent — safe to call repeatedly during
 * test runs.
 *
 * NOT a production feature. The route is intentionally namespaced under
 * /api/admin/debug/ so it's clear this is a test affordance.
 *
 * Body:
 *   { email: string, password: string, role?: "admin"|"developer"|"viewer",
 *     rolesJson?: string[], name?: string }
 */
export async function POST(req: NextRequest) {
  // Debug helper that mints/overwrites users with attacker-chosen passwords —
  // never expose it in production (it's an account-takeover primitive even
  // behind the admin gate: upsert can silently reset another admin's password).
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null) as {
    email?: string; password?: string; role?: string; rolesJson?: string[]; name?: string;
  } | null;
  if (!body?.email || !body?.password) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(body.password, 10);
  const target = await prisma.user.upsert({
    where: { email: body.email },
    update: { passwordHash, name: body.name ?? null },
    create: { email: body.email, name: body.name ?? null, passwordHash },
  });
  const membership = await prisma.membership.upsert({
    where: { userId_tenantId: { userId: target.id, tenantId: user.tenantId } },
    update: { role: body.role ?? "developer", rolesJson: JSON.stringify(body.rolesJson ?? []) },
    create: {
      userId: target.id,
      tenantId: user.tenantId,
      role: body.role ?? "developer",
      rolesJson: JSON.stringify(body.rolesJson ?? []),
    },
  });
  return NextResponse.json({
    user: { id: target.id, email: target.email, role: membership.role, rolesJson: membership.rolesJson },
  });
}
