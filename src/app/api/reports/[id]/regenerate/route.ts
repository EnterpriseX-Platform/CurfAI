/**
 * Comments-driven regenerate.
 *
 * POST /api/reports/[id]/regenerate
 *   Reads the existing report definition + every unresolved comment, sends
 *   them to the configured LLM with a refinement system prompt, and returns
 *   a new ReportSchema-validated definition. The previous definition is
 *   captured as a ReportVersion FIRST so the user can roll back via the
 *   version history panel if the regenerated version is worse.
 *
 *   Optional `extraPrompt` in the body augments the comment list — useful
 *   when the user wants to nudge the AI in a direction the comments don't
 *   spell out ("…and make the chart in section 2 a line not a bar").
 *
 *   Visibility: admin or editor on the report's tenant. Viewers cannot
 *   regenerate (read-only role).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { requireUser, requireAdminOrEditor, tenantWhere, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { ensureLimit } from "@/lib/rateLimit";
import { callLLM } from "@/lib/llm";
import { withTenantContext } from "@/lib/rls";

const Schema = z.object({
  /** Optional free-form refinement on top of the comments. */
  extraPrompt: z.string().max(2000).optional(),
  /** When false, only resolve `cellKey` is null comments (block-level).
   *  Default true — include cell-level comments too. */
  includeCellComments: z.boolean().default(true),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const limited = ensureLimit("regenerate", `t:${user.tenantId}`, 5, 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => ({}));
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }

  const report = await prisma.report.findFirst({
    where: { id: params.id, ...tenantWhere(user) },
  });
  if (!report) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  const currentDef = (() => {
    try { return JSON.parse(report.definition); } catch { return null; }
  })();
  if (!currentDef) {
    return NextResponse.json({ error: "Existing report definition is corrupt; regenerate from scratch via the catalog instead." }, { status: 422 });
  }

  // Pull unresolved comments. Order by oldest-first so the chronology of
  // the discussion is preserved in the prompt — Claude reads top-to-bottom
  // so stale early feedback can be overridden by later corrections.
  const comments = await prisma.comment.findMany({
    where: {
      tenantId: user.tenantId,
      reportId: report.id,
      resolvedAt: null,
      ...(parsed.data.includeCellComments ? {} : { cellKey: null }),
    },
    include: { author: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (comments.length === 0 && !parsed.data.extraPrompt) {
    return NextResponse.json({
      error: "No unresolved comments and no extraPrompt — nothing for the AI to refine. Add a comment or pass extraPrompt.",
    }, { status: 400 });
  }

  // ---- Refinement prompt ----
  // Build a block-id → label index so we can show "Block: <human label>"
  // next to each comment instead of a meaningless "blockId: c0d_3".
  const blockLabel = new Map<string, string>();
  for (const page of currentDef.pages ?? []) {
    for (const b of page.blocks ?? []) {
      const cfg = b.config ?? {};
      const label =
        (typeof cfg.text === "string" && cfg.text)
        || (typeof cfg.title === "string" && cfg.title)
        || (typeof cfg.label === "string" && cfg.label)
        || (typeof cfg.queryId === "string" && cfg.queryId)
        || b.type;
      blockLabel.set(b.id, `${b.type}: ${String(label).slice(0, 60)}`);
    }
  }

  const commentLines = comments.map((c: any) => {
    const who = c.author?.name || c.author?.email || "anon";
    const block = blockLabel.get(c.blockId) ?? `block ${c.blockId}`;
    const cell = c.cellKey ? ` cell="${c.cellKey}"` : "";
    return `- [${block}${cell}] ${who}: ${c.body}`;
  }).join("\n");

  const systemPrompt = [
    "You are Curf, refining an existing Curf report based on reviewer feedback. The user shows you the CURRENT report definition (as JSON) and a list of unresolved comments. You return ONE updated JSON object that addresses the feedback while preserving everything that wasn't called out.",
    "",
    "OUTPUT REQUIREMENTS:",
    "- Return ONE JSON object inside a single ```json code block. Nothing else.",
    "- The JSON MUST validate against the Curf ReportSchema (same shape as the input).",
    "- Preserve the report id, name, version, parameters, and dataSources unless a comment explicitly asks for changes there.",
    "- Preserve every existing block id when refining a block — losing the id breaks comment threads on it.",
    "- When a comment says \"add a chart for X\" or \"replace the bar with a line\", make a minimal, focused change. Don't restructure the whole report.",
    "- When a comment is vague (\"make this nicer\"), apply a light visual improvement to that block (e.g. tighten the title, add a unit suffix) and otherwise leave it alone.",
    "- When a comment is impossible (\"add data we don't have\"), keep the block as-is — the response shape only allows valid ReportSchema, you can't surface an error inline.",
    "",
    "PRESERVATION HEURISTIC:",
    "- If a block has no comment touching it, return it byte-for-byte unchanged. The diff vs the input should be minimal.",
    "- The dataSources[] array (queries) should only change if a comment asks for a metric/dimension that isn't in any current query. Otherwise reuse existing query ids.",
  ].join("\n");

  const userPrompt = [
    "CURRENT REPORT DEFINITION:",
    "```json",
    JSON.stringify(currentDef, null, 2),
    "```",
    "",
    "UNRESOLVED COMMENTS (oldest first):",
    commentLines || "(none)",
    "",
    parsed.data.extraPrompt ? "ADDITIONAL DIRECTION FROM THE USER:\n" + parsed.data.extraPrompt : "",
    "",
    "Return the refined ReportSchema JSON.",
  ].filter((s) => s.length > 0).join("\n");

  // ---- LLM call ----
  const llmResult = await callLLM({
    tenantId: user.tenantId,
    kind: "regenerate",
    reportId: report.id,
    userId: user.id,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 4000,
    responseFormat: "json",
  });
  if (llmResult.status === "failed") {
    return NextResponse.json({ error: llmResult.error || "AI request failed." }, { status: 500 });
  }

  const refined = extractJson(llmResult.text);
  if (!refined) {
    return NextResponse.json({
      error: "AI returned no parseable JSON. Try again or rephrase a comment.",
      raw: llmResult.text.slice(0, 500),
    }, { status: 422 });
  }

  // Backfill any required fields the LLM might have dropped.
  refined.version = refined.version ?? currentDef.version ?? 1;
  refined.parameters = refined.parameters ?? currentDef.parameters ?? [];
  refined.dataSources = refined.dataSources ?? currentDef.dataSources ?? [];
  refined.pages = refined.pages ?? currentDef.pages ?? [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }];
  refined.name = refined.name ?? currentDef.name ?? report.name;

  const validated = ReportSchema.safeParse(refined);
  if (!validated.success) {
    return NextResponse.json({
      error: "Refined report failed validation",
      issues: validated.error.issues.slice(0, 10),
      raw: JSON.stringify(refined).slice(0, 1000),
    }, { status: 422 });
  }
  const newDef = validated.data;

  // ---- Persist (with rollback safety) ----
  // Snapshot the current def as a ReportVersion BEFORE updating, so the
  // user can revert in one click if the regenerated version is worse.
  // Wrapped in a tenant context so RLS sees us as the right user.
  const result = await withTenantContext(user, async (tx) => {
    const nextVersion = (report.version ?? 1) + 1;

    await tx.reportVersion.create({
      data: {
        tenantId: user.tenantId,
        reportId: report.id,
        version: report.version ?? 1,
        definition: report.definition,
        note: "Pre-regenerate snapshot",
        createdById: user.id,
      },
    });

    const updated = await tx.report.update({
      where: { id: report.id },
      data: {
        definition: JSON.stringify(newDef),
        version: nextVersion,
        // Refresh name/description if the LLM tweaked them.
        name: newDef.name ?? report.name,
        description: newDef.description ?? report.description,
      },
    });
    return updated;
  });

  recordAudit({
    user, kind: "report.regenerate", target: report.id, req,
    meta: {
      commentCount: comments.length,
      hasExtraPrompt: !!parsed.data.extraPrompt,
      newVersion: result.version,
    },
  });

  return NextResponse.json({
    id: result.id,
    name: result.name,
    version: result.version,
    commentsConsumed: comments.length,
  });
}

// ---------------------------------------------------------------------------
// JSON extraction helper. The LLM call itself uses callLLM() above.
// ---------------------------------------------------------------------------

function extractJson(text: string): any | null {
  const fence = /```json\s*([\s\S]+?)```/i.exec(text);
  const candidate = fence ? fence[1] : firstJsonObject(text);
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
