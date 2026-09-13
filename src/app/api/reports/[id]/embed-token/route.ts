/**
 * /api/reports/[id]/embed-token — mint a signed embed token for one block.
 *
 * Auth: any user with read access to the report can mint. The token grants
 * data access at the SAME tenant level as the caller, so an editor can
 * embed a private block on their team wiki and the iframe sees the same
 * data they would.
 *
 * The endpoint never persists tokens — they're stateless capabilities.
 * Revocation strategy: rotate CURF_EMBED_SECRET (invalidates all tokens
 * at once) or use a short ttlDays + re-mint.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { mintEmbedToken } from "@/lib/embed/token";

const BodySchema = z.object({
  blockId: z.string().min(1),
  /** Optional frozen filter values that ride along with the token. */
  params: z.record(z.string(), z.unknown()).optional(),
  /** Default 365 — caller can pick shorter for sensitive embeds. */
  ttlDays: z.number().int().min(1).max(3650).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

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

  // Cheap definition probe — we don't need full schema parsing, just confirm
  // the blockId exists somewhere in the JSON.
  if (!reportRow.definition.includes(parsed.data.blockId)) {
    return NextResponse.json({ error: "Block not found in this report" }, { status: 404 });
  }

  const token = mintEmbedToken({
    tenantId: user.tenantId,
    reportId: params.id,
    blockId: parsed.data.blockId,
    params: parsed.data.params,
    ttlDays: parsed.data.ttlDays ?? 365,
  });

  const origin = new URL(req.url).origin;
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
