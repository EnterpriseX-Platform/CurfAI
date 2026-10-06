import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, tenantWhere, blockScopedApiKey } from "@/lib/auth";
import { canBuild } from "@/lib/roles";
import { recordAudit } from "@/lib/audit";
import { appBase } from "@/lib/http/appBase";
import { getTemplate } from "@/lib/templates/registry";

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  const base = appBase(req);
  if (!user) return NextResponse.redirect(new URL("/login", base));
  // A report-scoped key is meant to be limited to its allowlisted reports —
  // creating a brand-new one from a template is outside that mandate.
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;
  // Creating a report — the same rule as POST /api/reports.
  if (!canBuild(user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.formData().catch(() => null);
  const slug = (body?.get("slug") ?? "").toString();
  const tpl = getTemplate(slug);
  if (!tpl) return NextResponse.json({ error: "Unknown template" }, { status: 404 });

  // Resolve sample_warehouse id for bundled templates inside the caller's
  // tenant. The composite (tenantId, name) is the unique key now, so a plain
  // findUnique({where:{name:...}}) no longer compiles - use findFirst.
  const sw = tpl.bundled
    ? await prisma.dataSource.findFirst({
        where: { name: "sample_warehouse", ...tenantWhere(user) },
        select: { id: true },
      }).catch(() => null)
    : null;
  const def = tpl.build({ sampleWarehouseId: sw?.id });
  const created = await prisma.report.create({
    data: {
      tenantId: user.tenantId,
      name: def.name,
      description: undefined,
      category: def.category,
      definition: JSON.stringify(def),
      createdById: user.id,
    },
  });
  recordAudit({
    user, kind: "report.create", target: created.id, req,
    meta: { name: created.name, fromTemplate: slug },
  });
  return NextResponse.redirect(new URL("/reports/" + created.id + "/edit", base));
}
