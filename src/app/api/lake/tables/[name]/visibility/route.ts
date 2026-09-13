/**
 * /api/lake/tables/[name]/visibility — POST to update the table's ACL.
 *
 * Body shape:
 *   { mode: "tenant" }
 *   { mode: "roles", roles: ["admin", "analyst"] }
 *   { mode: "owner_only" }     ← caller becomes owner; can't transfer to another user via this endpoint
 *
 * Only the current owner OR a tenant admin can mutate ACL. The
 * "tenant" mode clears both ownerUserId and visibleToRolesJson back to
 * defaults.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const BodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("tenant") }),
  z.object({ mode: z.literal("roles"), roles: z.array(z.string().min(1)).min(1).max(20) }),
  z.object({ mode: z.literal("owner_only") }),
]);

export async function POST(req: NextRequest, { params }: { params: { name: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const row = await prisma.lakeTable.findFirst({
    where: { tenantId: user.tenantId, name: decodeURIComponent(params.name) },
  });
  if (!row) return NextResponse.json({ error: "Table not found" }, { status: 404 });

  const isOwner = row.ownerUserId === user.id;
  const isAdmin = user.role === "admin";
  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "Only the owner or an admin can change visibility." }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  let updated: any;
  if (parsed.data.mode === "tenant") {
    updated = await prisma.lakeTable.update({
      where: { id: row.id },
      data: { ownerUserId: null, visibleToRolesJson: "[]" },
    });
  } else if (parsed.data.mode === "roles") {
    updated = await prisma.lakeTable.update({
      where: { id: row.id },
      data: { ownerUserId: null, visibleToRolesJson: JSON.stringify(parsed.data.roles) },
    });
  } else {
    // owner_only — caller becomes the owner. Admins can grab ownership
    // of orphan tables this way too (useful for housekeeping when the
    // original creator left the workspace).
    updated = await prisma.lakeTable.update({
      where: { id: row.id },
      data: { ownerUserId: user.id, visibleToRolesJson: "[]" },
    });
  }
  recordAudit({
    user, kind: "lake.table.visibility.update", target: row.id, req,
    meta: { mode: parsed.data.mode, ...(parsed.data.mode === "roles" ? { roles: parsed.data.roles } : {}) },
  });
  return NextResponse.json({
    ok: true,
    visibility: {
      ownerUserId: updated.ownerUserId,
      visibleToRoles: JSON.parse(updated.visibleToRolesJson ?? "[]"),
    },
  });
}
