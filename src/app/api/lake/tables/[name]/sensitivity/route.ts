/**
 * /api/lake/tables/[name]/sensitivity — set / clear column sensitivity tags.
 *
 * Body: { column: "email", sensitivity: "pii" | null, unredactedForRoles?: ["analyst"] }
 *
 * Owner / admin only (same gate as visibility + schema). Sensitivity is
 * persisted on the LakeTable row's schemaJson alongside the rest of the
 * column metadata — keeps the source of truth in one place.
 *
 * Setting sensitivity to null clears the tag (column treated as ordinary).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { canBuild } from "@/lib/roles";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  column: z.string().min(1).max(60),
  sensitivity: z.enum(["pii", "financial", "health", "secret"]).nullable(),
  unredactedForRoles: z.array(z.string().min(1)).max(20).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { name: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const row = await prisma.lakeTable.findFirst({
    where: { tenantId: user.tenantId, name: decodeURIComponent(params.name) },
  });
  if (!row) return NextResponse.json({ error: "Table not found" }, { status: 404 });

  const isOwner = row.ownerUserId === user.id;
  const isAdmin = user.role === "admin";
  if (!isOwner && !isAdmin && row.ownerUserId) {
    return NextResponse.json({ error: "Only the owner or an admin can change sensitivity tags." }, { status: 403 });
  }
  if (!canBuild(user.role)) {
    return NextResponse.json({ error: "Editors only" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  // Walk the cached schema and update the matching column. Preserves
  // the type/sample fields untouched.
  let schema: any[];
  try { schema = JSON.parse(row.schemaJson) ?? []; }
  catch { schema = []; }
  const idx = schema.findIndex((c) => c.name === parsed.data.column);
  if (idx === -1) return NextResponse.json({ error: `Column "${parsed.data.column}" not in schema` }, { status: 404 });

  if (parsed.data.sensitivity == null) {
    delete schema[idx].sensitivity;
    delete schema[idx].unredactedForRoles;
  } else {
    schema[idx].sensitivity = parsed.data.sensitivity;
    if (parsed.data.unredactedForRoles !== undefined) {
      schema[idx].unredactedForRoles = parsed.data.unredactedForRoles;
    }
  }

  await prisma.lakeTable.update({
    where: { id: row.id },
    data: { schemaJson: JSON.stringify(schema), updatedAt: new Date() },
  });

  recordAudit({
    user, kind: "lake.table.sensitivity.update", target: row.id, req,
    meta: {
      name: row.name,
      column: parsed.data.column,
      sensitivity: parsed.data.sensitivity,
      unredactedForRoles: parsed.data.unredactedForRoles ?? [],
    },
  });

  return NextResponse.json({ ok: true, column: schema[idx] });
}
