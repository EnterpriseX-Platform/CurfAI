import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin, tenantWhere } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

/** Rename a tag's display label/description. The slug itself is immutable —
 * it's what's actually stored on every Membership.rolesJson and every
 * visibleToRolesJson column, so changing it would mean rewriting every
 * reference (same reasoning DELETE already applies when a tag is removed). */
export async function PATCH(req: NextRequest, { params }: { params: { slug: string } }) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const body = await req.json().catch(() => null) as { label?: string; description?: string | null } | null;
  if (!body?.label?.trim()) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }

  const existing = await prisma.role.findFirst({ where: { slug: params.slug, ...tenantWhere(u) } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updated = await prisma.role.update({
    where: { id: existing.id },
    data: { label: body.label.trim(), description: body.description?.trim() || null },
  });
  recordAudit({
    user: u, kind: "role.update", target: existing.id, req,
    meta: { slug: params.slug, label: updated.label },
  });
  return NextResponse.json({ role: updated });
}

export async function DELETE(req: NextRequest, { params }: { params: { slug: string } }) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;
  // Tenant-scope the delete so cross-tenant slug collisions aren't an issue.
  const deleted = await prisma.role.deleteMany({
    where: { slug: params.slug, ...tenantWhere(u) },
  });
  // Strip this slug from every tenant member's rolesJson (now on their
  // Membership for this workspace) so we don't keep a stale reference
  // dangling after the role row is gone.
  const memberships = await prisma.membership.findMany({
    where: tenantWhere(u),
    select: { userId: true, tenantId: true, rolesJson: true },
  });
  for (const row of memberships) {
    try {
      const arr = JSON.parse(row.rolesJson ?? "[]");
      if (Array.isArray(arr) && arr.includes(params.slug)) {
        const next = arr.filter((r: string) => r !== params.slug);
        await prisma.membership.update({
          where: { userId_tenantId: { userId: row.userId, tenantId: row.tenantId } },
          data: { rolesJson: JSON.stringify(next) },
        });
      }
    } catch { /* ignore */ }
  }
  recordAudit({
    user: u, kind: "role.delete", target: params.slug, req,
    meta: { rolesDeleted: deleted.count, usersScanned: memberships.length },
  });
  return NextResponse.json({ ok: true });
}
