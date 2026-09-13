import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

// PDPA processing record — a single tenant-wide summary (Tenant.pdpaRecordJson),
// not a multi-activity register. See prisma/schema.prisma's doc comment on
// pdpaRecordJson for the exact shape. No GET here: the settings page
// (admin/tenant/page.tsx) already fetches the full Tenant row server-side
// and passes the parsed record down as a prop, same as currency/region.

const PatchSchema = z.object({
  controllerName: z.string().max(200).optional(),
  dpoContact: z.string().max(200).optional(),
  dataCategories: z.array(z.string().min(1).max(100)).max(50),
  purposeOfProcessing: z.string().max(2000),
  legalBasis: z.enum([
    "consent", "contract", "legal_obligation",
    "vital_interest", "public_task", "legitimate_interest",
  ]),
  retentionPeriod: z.string().max(200),
  thirdPartySharing: z.string().max(1000).optional(),
});

export async function PATCH(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }

  const record = { ...parsed.data, lastReviewedAt: new Date().toISOString() };

  await prisma.tenant.update({
    where: { id: user.tenantId },
    data: { pdpaRecordJson: JSON.stringify(record) },
  });
  recordAudit({
    user, kind: "tenant.pdpa.update", target: user.tenantId, req,
    meta: { legalBasis: record.legalBasis, dataCategoryCount: record.dataCategories.length },
  });
  return NextResponse.json(record);
}
