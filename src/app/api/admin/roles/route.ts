import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, tenantWhere, type CurfSessionUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

async function adminGuard(req?: NextRequest): Promise<{ user: CurfSessionUser } | { error: NextResponse }> {
  const user = await requireUser(req);
  if (!user || user.role !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user };
}

export async function GET(req: NextRequest) {
  const guard = await adminGuard(req);
  if ("error" in guard) return guard.error;
  const rows = await prisma.role.findMany({
    where: tenantWhere(guard.user),
    orderBy: { slug: "asc" },
  });
  return NextResponse.json({ items: rows });
}

export async function POST(req: NextRequest) {
  const guard = await adminGuard(req);
  if ("error" in guard) return guard.error;
  const { user } = guard;
  const body = await req.json().catch(() => null) as { slug?: string; label?: string; description?: string } | null;
  if (!body?.slug || !body?.label) {
    return NextResponse.json({ error: "slug and label are required" }, { status: 400 });
  }
  const slug = body.slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  try {
    const row = await prisma.role.create({
      data: {
        tenantId: user.tenantId,
        slug,
        label: body.label.trim(),
        description: body.description?.trim() ?? null,
      },
    });
    recordAudit({
      user, kind: "role.create", target: row.id, req,
      meta: { slug, label: body.label.trim() },
    });
    return NextResponse.json({ role: row });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Create failed" }, { status: 400 });
  }
}
