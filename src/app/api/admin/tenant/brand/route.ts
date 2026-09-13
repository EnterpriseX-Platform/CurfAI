/**
 * /api/admin/tenant/brand — workspace branding (Business plan).
 *
 * GET — anyone in the tenant can read brand (it's already what they see)
 * PUT — admin-only, gated gov.custom_branding (Business). Custom palette
 *        validates as 1..10 hex strings; missing fields persist as null.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { featureGate } from "@/lib/featureGate";
import { ThemeSchema, ChartStyleSchema } from "@/lib/reporting/schema";
import { recordAudit } from "@/lib/audit";

const HexColor = z.string().regex(/^#?[0-9a-fA-F]{6}$/);

const BrandSchema = z.object({
  logoUrl:       z.string().url().or(z.literal("")).optional(),
  accentColor:   HexColor.or(z.literal("")).optional(),
  defaultTheme:  ThemeSchema.optional(),
  /** Workspace-wide chart *form* — a separate axis from defaultTheme's colour. */
  defaultChartStyle: ChartStyleSchema.optional(),
  customPalette: z.array(HexColor).max(10).optional(),
});

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const row = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { brandJson: true } as any,
  });
  let brand: Record<string, unknown> = {};
  try { brand = row ? JSON.parse((row as any).brandJson || "{}") : {}; } catch {}
  return NextResponse.json({ brand });
}

export async function PUT(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const block = await featureGate(user, "gov.custom_branding");
  if (block) return block;

  const body = await req.json().catch(() => ({}));
  const parsed = BrandSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid brand", issues: parsed.error.issues }, { status: 400 });
  }
  // Normalize hex colors: ensure leading "#".
  const normHex = (h: string | undefined) => h && !h.startsWith("#") ? `#${h}` : h;
  const data = {
    ...parsed.data,
    accentColor:   normHex(parsed.data.accentColor),
    customPalette: parsed.data.customPalette?.map((c) => normHex(c)!).filter(Boolean),
  };
  await (prisma.tenant as any).update({
    where: { id: user.tenantId },
    data: { brandJson: JSON.stringify(data) },
  });
  recordAudit({ user, kind: "tenant.brand.update", target: user.tenantId, req, meta: { fields: Object.keys(data) } });
  return NextResponse.json({ ok: true, brand: data });
}
