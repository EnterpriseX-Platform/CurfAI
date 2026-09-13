import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { dispatchDelivery, type DeliveryConfig, type Rendered } from "@/lib/delivery/dispatch";
import { emitWebhook } from "@/lib/webhooks";

/**
 * GET  /api/reports/:id/comments   — list comments on this report
 * POST /api/reports/:id/comments   — create a new comment on a block.
 *
 * On POST: after the write succeeds, notify the report owner and anyone who
 * has already commented on this block (except the author themselves). Emails
 * are best-effort - a failed send never blocks the create. Requires SMTP_*
 * env vars + `npm install nodemailer` (the dispatcher returns "skipped"
 * otherwise).
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;
  const report = await prisma.report.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true },
  });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await prisma.comment.findMany({
    where: { tenantId: user.tenantId, reportId: params.id },
    orderBy: { createdAt: "asc" },
    include: { author: { select: { id: true, name: true, email: true } } },
  });
  return NextResponse.json({
    items: rows.map((c: any) => ({
      id: c.id,
      blockId: c.blockId,
      cellKey: c.cellKey,
      body: c.body,
      proofHash: c.proofHash,
      resolvedAt: c.resolvedAt,
      parentId: c.parentId ?? null,
      mentions: safeParseJson(c.mentionsJson),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      author: c.author ? { id: c.author.id, name: c.author.name, email: c.author.email } : null,
    })),
  });
}

function safeParseJson(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

const CreateSchema = z.object({
  blockId: z.string().min(1),
  cellKey: z.string().optional(),
  body: z.string().min(1).max(5000),
  proofHash: z.string().optional(),
  /** When set, this is a reply to an existing top-level comment. */
  parentId: z.string().optional(),
  /** Optional list of user IDs @-mentioned in the body. The client
   *  resolves the mentions from its autocomplete; we just store them. */
  mentions: z.array(z.string()).max(20).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const report = await prisma.report.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: {
      id: true,
      name: true,
      createdBy: { select: { id: true, email: true, name: true } },
    },
  });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  // For replies, derive blockId from the parent so a misbehaving client can't
  // attach a reply to a different block from its parent.
  let effectiveBlockId = parsed.data.blockId;
  if (parsed.data.parentId) {
    const parent = await prisma.comment.findFirst({
      where: { id: parsed.data.parentId, reportId: params.id, tenantId: user.tenantId },
      select: { blockId: true },
    });
    if (!parent) return NextResponse.json({ error: "Parent comment not found" }, { status: 404 });
    effectiveBlockId = parent.blockId;
  }

  const created = await prisma.comment.create({
    data: {
      tenantId: user.tenantId,
      reportId: params.id,
      blockId: effectiveBlockId,
      cellKey: parsed.data.cellKey ?? null,
      body: parsed.data.body,
      proofHash: parsed.data.proofHash ?? null,
      authorId: user.id,
      parentId: parsed.data.parentId ?? null,
      mentionsJson: JSON.stringify(parsed.data.mentions ?? []),
    },
    include: { author: { select: { id: true, name: true, email: true } } },
  });

  recordAudit({
    user, kind: "report.comment.create", target: created.id, req,
    meta: { reportId: params.id, blockId: effectiveBlockId, parentId: parsed.data.parentId ?? null },
  });

  // Fire off notifications asynchronously. Failures are logged but never
  // bubble up — the comment is already saved.
  void notifyNewComment({
    req, reportId: params.id, reportName: report.name,
    ownerEmail: report.createdBy?.email, authorId: user.id, tenantId: user.tenantId,
    body: parsed.data.body, blockId: parsed.data.blockId,
    mentionedUserIds: parsed.data.mentions ?? [],
  });
  // Outbound webhook for external systems (Linear, Notion, Slack via
  // a webhook endpoint, custom triage queue). The notifyNewComment path
  // above is in-product email; this is the integration layer.
  void emitWebhook({
    tenantId: user.tenantId,
    event: "comment.posted",
    data: {
      commentId: created.id,
      reportId: params.id,
      blockId: effectiveBlockId,
      author: created.author?.email ?? null,
      authorName: created.author?.name ?? null,
      body: parsed.data.body.slice(0, 500),
      mentions: parsed.data.mentions ?? [],
    },
  });

  return NextResponse.json({
    id: created.id,
    blockId: created.blockId,
    cellKey: created.cellKey,
    body: created.body,
    proofHash: created.proofHash,
    resolvedAt: created.resolvedAt,
    parentId: created.parentId ?? null,
    mentions: parsed.data.mentions ?? [],
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
    author: created.author ? { id: created.author.id, name: created.author.name, email: created.author.email } : null,
  });
}

async function notifyNewComment(ctx: {
  req: NextRequest;
  reportId: string;
  reportName: string;
  ownerEmail: string | null | undefined;
  authorId: string;
  tenantId: string;
  body: string;
  blockId: string;
  mentionedUserIds: string[];
}) {
  try {
    // Collect recipients in three buckets:
    //   1. Owner of the report (always).
    //   2. Anyone who previously commented on this report (collab tradition).
    //   3. Anyone @-mentioned in THIS comment (the explicit ping).
    // Mentioned users get the same email as the rest in v1; later we can
    // route them through a stronger channel (in-app inbox, push) since
    // a mention is a deliberate ask for attention.
    const priors = await prisma.comment.findMany({
      where: { reportId: ctx.reportId, tenantId: ctx.tenantId, NOT: { authorId: ctx.authorId } },
      select: { author: { select: { email: true } } },
      distinct: ["authorId"],
    });
    const set = new Set<string>();
    if (ctx.ownerEmail) set.add(ctx.ownerEmail);
    for (const p of priors) if (p.author?.email) set.add(p.author.email);
    if (ctx.mentionedUserIds.length > 0) {
      const mentioned = await prisma.user.findMany({
        where: {
          id: { in: ctx.mentionedUserIds },
          NOT: { id: ctx.authorId },
          memberships: { some: { tenantId: ctx.tenantId } },
        },
        select: { email: true },
      });
      for (const u of mentioned) if (u.email) set.add(u.email);
    }
    const recipients = Array.from(set).filter(Boolean);
    if (recipients.length === 0) return;

    const origin = new URL(ctx.req.url).origin;
    const reportUrl = `${origin}/reports/${ctx.reportId}`;
    const config: DeliveryConfig = {
      kind: "email",
      recipients,
      subject: `New comment on "${ctx.reportName}"`,
    };
    const rendered: Rendered = {
      body: Buffer.from(
        `A new comment was added to "${ctx.reportName}".\n\n` +
        `Block: ${ctx.blockId}\n` +
        `---\n${ctx.body}\n---\n\n` +
        `Open the report: ${reportUrl}\n`,
        "utf8",
      ),
      filename: "comment-notification.txt",
      contentType: "text/plain",
      reportName: ctx.reportName,
      reportId: ctx.reportId,
      origin,
    };
    const result = await dispatchDelivery(config, rendered);
    if (process.env.NODE_ENV !== "production") {
      console.log(`[comment-notify] ${result.status}: ${result.message} (to ${recipients.length} recipient(s))`);
    }
  } catch (err) {
    console.error("[comment-notify] failed:", err);
  }
}
