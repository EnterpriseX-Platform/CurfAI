import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdminOrEditor, tenantWhere } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { parseManualSchema } from "@/lib/connections/probe";

/**
 * GET    /api/data-sources/[id]/schema — read the current discovered schema
 * PUT    /api/data-sources/[id]/schema — set a manually-declared schema
 * DELETE /api/data-sources/[id]/schema — clear the discovered schema
 *
 * The manual override is for when the auto-probe can't reach the API (auth
 * required, weird response shape, behind a VPN). Accepts either a freeform
 * "field: type, ..." string or a JSON object matching DiscoveredSchema.
 */

const PutSchema = z.object({
  text: z.string().min(1).max(10_000),
});

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ds = await prisma.dataSource.findFirst({
    where: { id: params.id, ...tenantWhere(user) },
    select: { id: true, name: true, kind: true, discoveredSchemaJson: true },
  });
  if (!ds) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const schema = ds.discoveredSchemaJson ? JSON.parse(ds.discoveredSchemaJson) : null;
  return NextResponse.json({ id: ds.id, name: ds.name, kind: ds.kind, schema });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }

  const ds = await prisma.dataSource.findFirst({
    where: { id: params.id, ...tenantWhere(user) },
    select: { id: true, name: true },
  });
  if (!ds) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = parseManualSchema(parsed.data.text);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }

  await prisma.dataSource.update({
    where: { id: ds.id },
    data: { discoveredSchemaJson: JSON.stringify(result.schema) },
  });

  recordAudit({
    user, kind: "datasource.schema.manual", target: ds.id, req,
    meta: { name: ds.name, fieldCount: result.schema.fields.length },
  });

  return NextResponse.json({ ok: true, schema: result.schema });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;

  const ds = await prisma.dataSource.findFirst({
    where: { id: params.id, ...tenantWhere(user) },
    select: { id: true, name: true },
  });
  if (!ds) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.dataSource.update({
    where: { id: ds.id },
    data: { discoveredSchemaJson: null },
  });

  recordAudit({
    user, kind: "datasource.schema.clear", target: ds.id, req,
    meta: { name: ds.name },
  });

  return NextResponse.json({ ok: true });
}
