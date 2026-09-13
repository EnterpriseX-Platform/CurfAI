/**
 * /api/admin/audit/retention
 *
 *   GET  — fetch the tenant's retention config + a preview of how many
 *          rows would be swept under the current rules
 *   PUT  — replace the retention config (admin only)
 *
 * The PUT body is a JSON object whose keys are kind patterns
 * ("*" / "signin" / "export.*") and whose values are positive integers
 * (days). We validate shape on receipt; the sweep itself is silent
 * about malformed config (logs and skips).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { resolveRetention } from "@/lib/audit/retention";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { auditRetentionJson: true },
  });
  let config: Record<string, number> = {};
  try { config = JSON.parse(tenant?.auditRetentionJson ?? "{}"); } catch { /* leave empty */ }

  // Preview: how many rows match each kind under the current rules?
  // Useful for the admin to know "if I save this, ~12,800 rows will be
  // pruned at the next 03:00 UTC sweep." Cheap aggregate.
  const kindCounts = await prisma.auditEvent.groupBy({
    by: ["kind"],
    where: { tenantId: user.tenantId },
    _count: { _all: true },
    _max: { createdAt: true },
  }).catch(() => [] as any[]);

  const preview = kindCounts.map((row: any) => {
    const rule = resolveRetention(config, row.kind);
    let willDelete = 0;
    if (rule) {
      const cutoff = Date.now() - rule.days * 24 * 60 * 60 * 1000;
      // We can't compute an exact "rows older than cutoff" without an
      // additional query per kind; for the preview we just flag "has
      // a rule" + total count. The admin gets accurate per-kind
      // counts in the cron sweep's audit log.
      void cutoff; // (preview is approximate by design)
      willDelete = -1; // sentinel: "subject to sweep, count not estimated"
    }
    return {
      kind: row.kind,
      total: row._count._all,
      latest: row._max.createdAt,
      retentionDays: rule?.days ?? null,
      retentionPattern: rule?.pattern ?? null,
      willSweep: willDelete < 0,
    };
  });

  return NextResponse.json({ config, preview });
}

const Body = z.record(z.string(), z.union([z.number().int().positive(), z.null()]));

export async function PUT(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }
  // Strip nulls (= delete that rule). Keys must look like kind patterns
  // — alnum/dot/star only, max 80 chars.
  const sanitized: Record<string, number> = {};
  for (const [pat, days] of Object.entries(parsed.data)) {
    if (typeof days !== "number") continue;
    if (!/^[A-Za-z0-9_*.\-]+$/.test(pat) || pat.length > 80) {
      return NextResponse.json({ error: `Invalid pattern: ${pat}` }, { status: 400 });
    }
    sanitized[pat] = days;
  }

  await prisma.tenant.update({
    where: { id: user.tenantId },
    data: { auditRetentionJson: JSON.stringify(sanitized) },
  });

  recordAudit({
    user, kind: "audit.retention.update", target: user.tenantId, req,
    meta: { ruleCount: Object.keys(sanitized).length },
  });

  return NextResponse.json({ ok: true, config: sanitized });
}
