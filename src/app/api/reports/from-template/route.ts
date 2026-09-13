import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, tenantWhere, blockScopedApiKey } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { getTemplate } from "@/lib/templates/registry";

function appBase(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (proto && host) return `${proto}://${host}`;
  return process.env.NEXTAUTH_URL ?? new URL(req.url).origin;
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  const base = appBase(req);
  if (!user) return NextResponse.redirect(new URL("/login", base));
  // A report-scoped key is meant to be limited to its allowlisted reports —
  // creating a brand-new one from a template is outside that mandate.
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;

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
