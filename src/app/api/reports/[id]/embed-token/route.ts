/**
 * /api/reports/[id]/embed-token — mint a signed embed token for one block.
 *
 * Auth: any user with read access to the report can mint, for a block they
 * can see. The iframe is public, anyone with the URL loads it, so it
 * renders as nobody: a block the author limited to certain roles can't be
 * embedded, and a data source limited to roles shows no rows there.
 *
 * The endpoint never persists tokens — they're stateless capabilities.
 * Revocation strategy: rotate CURF_EMBED_SECRET (invalidates all tokens
 * at once) or use a short ttlDays + re-mint.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdminOrEditor, requireReportInScope, getUserRoles } from "@/lib/auth";
import { ReportSchema, findBlock } from "@/lib/reporting/schema";
import { visibleReport } from "@/lib/reporting/visibleReport";
import { mintEmbedToken } from "@/lib/embed/token";
import { featureGate } from "@/lib/featureGate";
import { appBase } from "@/lib/http/appBase";

const BodySchema = z.object({
  blockId: z.string().min(1),
  /** Optional frozen filter values that ride along with the token. */
  params: z.record(z.string(), z.unknown()).optional(),
  /** Default 365 — caller can pick shorter for sensitive embeds. */
  ttlDays: z.number().int().min(1).max(365).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  // An embed token is a public link to report data — the same role as
  // sharing the report (POST /api/reports/[id]/share).
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;
  // Embedding is a Growth capability and has been sold as one in the public
  // docs, but delivery.embed_iframe sat in FEATURE_TIERS with nothing
  // reading it — every tier could mint an embed token from the button that
  // renders on every chart block.
  const tierBlock = await featureGate(user, "delivery.embed_iframe");
  if (tierBlock) return tierBlock;

  const body = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }

  // Confirm the report + block both live in this tenant.
  const reportRow = await prisma.report.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true, definition: true },
  });
  if (!reportRow) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  // The block has to be one the caller can see. This used to be a substring
  // check on the definition, so a viewer could mint an embed of a block the
  // author hid from them and open it. Hidden reads as missing.
  const def = ReportSchema.safeParse(JSON.parse(reportRow.definition));
  if (!def.success) return NextResponse.json({ error: "Invalid report definition" }, { status: 422 });
  const block = findBlock(
    visibleReport(def.data, { isAdmin: user.role === "admin", roles: await getUserRoles() }),
    parsed.data.blockId,
  );
  if (!block) {
    return NextResponse.json({ error: "Block not found in this report" }, { status: 404 });
  }
  if (block.visibleToRoles?.length) {
    return NextResponse.json(
      { error: "This block is limited to certain roles, so it can't be embedded: anyone with the embed link could see it." },
      { status: 400 },
    );
  }

  const token = mintEmbedToken({
    tenantId: user.tenantId,
    reportId: params.id,
    blockId: parsed.data.blockId,
    params: parsed.data.params,
    ttlDays: parsed.data.ttlDays ?? 365,
  });

  const origin = appBase(req);
  // Path is /embed/block/... not /embed/... because /embed/[token] (the
  // legacy whole-report share embed) already owns the first dynamic
  // segment under /embed.
  const url = `${origin}/embed/block/${params.id}/${parsed.data.blockId}?token=${encodeURIComponent(token)}`;
  // Recommended iframe snippet — auto-resize to content using the standard
  // iframe-resizer pattern (consumer can also pin a fixed height).
  const iframe = `<iframe src="${url}" loading="lazy" style="width:100%;height:520px;border:0;border-radius:12px;" allowfullscreen></iframe>`;

  return NextResponse.json({
    token,
    url,
    iframe,
    expiresAt: Date.now() + (parsed.data.ttlDays ?? 365) * 86400_000,
  });
}
