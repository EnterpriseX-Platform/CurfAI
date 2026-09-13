import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin, MEMBERSHIP_ROLES } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { mintAndSendInvite } from "@/lib/invites";

/**
 * Admin user list + invite endpoint.
 *
 * GET  - list members of this workspace (via Membership), with pendingInvite
 *        flag for users that haven't accepted yet (passwordHash is null).
 * POST - invite a user into this workspace.
 *          - Email has no account anywhere yet: create a User row WITHOUT a
 *            passwordHash + delegate to mintAndSendInvite() to mint a 7-day
 *            token + send the accept email, same as before.
 *          - Email already has an account (any workspace): just add a
 *            Membership here — no new credential, no reset-token flow. The
 *            account keeps its existing password.
 */

export async function GET(req: NextRequest) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;
  const rows = await prisma.membership.findMany({
    where: { tenantId: u.tenantId },
    include: { user: { select: { id: true, email: true, name: true, passwordHash: true } } },
    orderBy: { user: { email: "asc" } },
  });
  const items = rows.map((m: any) => {
    let roles: string[] = [];
    try { roles = JSON.parse(m.rolesJson ?? "[]"); } catch { /* ignore */ }
    return {
      id: m.user.id, email: m.user.email, name: m.user.name, authRole: m.role, roles,
      pendingInvite: !m.user.passwordHash,
    };
  });
  return NextResponse.json({ items });
}

const InviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(80).optional(),
  role: z.enum(MEMBERSHIP_ROLES).default("developer"),
});

export async function POST(req: NextRequest) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const body = await req.json().catch(() => null);
  const parsed = InviteSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  const tenant = await prisma.tenant.findUnique({
    where: { id: u.tenantId },
    select: { name: true, slug: true },
  });
  const origin = new URL(req.url).origin;

  const existingUser = await prisma.user.findUnique({ where: { email: parsed.data.email } });

  if (existingUser) {
    const already = await prisma.membership.findUnique({
      where: { userId_tenantId: { userId: existingUser.id, tenantId: u.tenantId } },
    });
    if (already) {
      return NextResponse.json(
        { error: `${parsed.data.email} is already a member of this workspace.` },
        { status: 409 },
      );
    }
    const membership = await prisma.membership.create({
      data: { userId: existingUser.id, tenantId: u.tenantId, role: parsed.data.role },
    });

    let emailStatus: "sent" | "skipped" | "failed" = "skipped";
    try {
      const mod = await import("@/lib/delivery/dispatch");
      const result = await mod.dispatchDelivery(
        { kind: "email", recipients: [existingUser.email], subject: "You've been added to " + (tenant?.name ?? "a workspace") + " on Curf" },
        {
          body: Buffer.from(
            "Hello" + (existingUser.name ? " " + existingUser.name : "") + ",\n\n" +
            (u.name ?? u.email) + " has added you to \"" + (tenant?.name ?? "Curf") + "\" as " + membership.role + ".\n\n" +
            "Log in with your existing Curf password and switch workspace from the sidebar:\n" +
            origin + "/login\n",
            "utf8",
          ),
          filename: "workspace-added.txt",
          contentType: "text/plain",
          reportName: "Workspace access granted",
          reportId: "workspace-added",
          origin,
        },
      );
      emailStatus = result.status === "delivered" ? "sent" : result.status === "skipped" ? "skipped" : "failed";
    } catch { emailStatus = "failed"; }

    recordAudit({
      user: u, kind: "user.invite", target: existingUser.id, req,
      meta: { email: existingUser.email, role: membership.role, existingAccount: true, emailStatus },
    });

    return NextResponse.json({
      id: existingUser.id,
      email: existingUser.email,
      name: existingUser.name,
      role: membership.role,
      existingAccount: true,
      emailStatus,
      acceptUrl: null,
    });
  }

  let user: any;
  try {
    user = await prisma.user.create({
      data: {
        email: parsed.data.email,
        name: parsed.data.name ?? null,
        // Deliberately no passwordHash - invitee sets it via /reset/[token].
      },
    });
  } catch (e: any) {
    if (e?.code === "P2002") {
      return NextResponse.json(
        { error: 'An account with email "' + parsed.data.email + '" already exists.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: e?.message ?? "Invite failed" }, { status: 500 });
  }
  const membership = await prisma.membership.create({
    data: { userId: user.id, tenantId: u.tenantId, role: parsed.data.role },
  });

  const minted = await mintAndSendInvite({
    tenantId: u.tenantId,
    tenantName: tenant?.name ?? "Curf",
    inviterName: u.name ?? u.email,
    user: { id: user.id, email: user.email, name: user.name, role: membership.role },
    origin,
  });

  recordAudit({
    user: u, kind: "user.invite", target: user.id, req,
    meta: {
      email: user.email,
      role: membership.role,
      emailStatus: minted.emailStatus,
      expiresAt: minted.expiresAt.toISOString(),
    },
  });

  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: membership.role,
    emailStatus: minted.emailStatus,
    // Only return the URL when SMTP is missing/failed - so admins always have
    // a way to deliver it, but a successful email send doesn't echo the
    // sensitive token back to the inviter.
    acceptUrl: minted.emailStatus === "sent" ? null : minted.acceptUrl,
    expiresAt: minted.expiresAt.toISOString(),
  });
}
