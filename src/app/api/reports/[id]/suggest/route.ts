/**
 * /api/reports/[id]/suggest — AI proposes the next chart.
 *
 * Reads:
 *   - the report's current blocks (so suggestions don't duplicate)
 *   - each data source's introspected columns (sample 1 row per query)
 *   - the report's parameters
 *
 * Sends the model a structured prompt + asks for 1-3 suggestions in a
 * strict JSON shape. Each suggestion is { title, queryId, chartType,
 * xField, yFields, rationale }. The client renders them as cards in a
 * modal; clicking Apply pushes a new block onto the report.
 *
 * Provider-agnostic via callLLM(). Gated ai.suggest_charts (Team).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { featureGate } from "@/lib/featureGate";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReportWithProof } from "@/lib/reporting/runner";
import { callLLM } from "@/lib/llm";

const SuggestionSchema = z.object({
  title: z.string().min(1),
  rationale: z.string().min(1),
  queryId: z.string().min(1),
  chartType: z.enum(["bar", "line", "area", "pie", "donut", "combo", "treemap", "funnel", "scatter"]),
  xField: z.string().min(1),
  yFields: z.array(z.string()).min(1).max(3),
});
const ResponseSchema = z.object({ suggestions: z.array(SuggestionSchema).max(3) });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;
  const block = await featureGate(user, "ai.suggest_charts");
  if (block) return block;

  const row = await prisma.report.findFirst({ where: { id: params.id, tenantId: user.tenantId } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const report = ReportSchema.parse(JSON.parse(row.definition));

  // Run each data source once to capture column names + a 3-row sample.
  // We deliberately only sample (not the full dataset) — Claude only needs
  // the SHAPE of the data to suggest a chart, not the values.
  const pvals: Record<string, unknown> = {};
  for (const p of report.parameters) pvals[p.name] = p.default ?? "";
  const datasets: Record<string, any[]> = {};
  try {
    const result = await runReportWithProof({
      report, params: pvals,
      viewer: { id: user.id, isAdmin: user.role === "admin", roles: [] },
    });
    for (const [k, rows] of Object.entries(result.dataset)) {
      datasets[k] = (rows as any[]).slice(0, 3);
    }
  } catch (e) {
    return NextResponse.json({ error: "Couldn't run report data sources for inspection." }, { status: 500 });
  }

  const datasetSummary = Object.entries(datasets).map(([qid, rows]) => {
    const first = rows[0] ?? {};
    const cols = Object.keys(first).map((k) => ({ name: k, sample: first[k] }));
    return { queryId: qid, rowCount: rows.length, columns: cols };
  });

  const existingBlocks = report.pages.flatMap((p) =>
    p.blocks
      .filter((b) => b.type === "chart")
      .map((b) => ({
        id: b.id,
        chartType: (b.config as any).chartType,
        queryId: (b.config as any).queryId,
        xField: (b.config as any).xField,
        yFields: (b.config as any).yFields,
        title: (b.config as any).title,
      }))
  );

  const system = [
    "You are Curf, an analytics designer. Your job: propose the next chart to add to a report.",
    "Look at the available data sources and the existing charts; suggest 1 to 3 NEW charts that would add insight.",
    "Constraints:",
    "- Don't duplicate an existing chart's (queryId, xField, yFields) tuple.",
    "- Pick chartType from: bar, line, area, pie, donut, combo, treemap, funnel, scatter.",
    "- xField MUST be a column that exists in the chosen queryId's data.",
    "- yFields MUST all exist in the chosen queryId's data; ALL must be numeric (the sample value should look like a number).",
    "- Prefer line/area for time-series-looking xFields (date, week, month, quarter); bar for categorical.",
    "- Each suggestion needs a one-sentence `rationale` explaining what it would reveal.",
    "Output STRICT JSON: { \"suggestions\": [ { title, rationale, queryId, chartType, xField, yFields }, ... ] } and NOTHING else.",
  ].join("\n");

  const userMsg = [
    `Report name: ${report.name}`,
    `Available data sources (with sample rows):\n${JSON.stringify(datasetSummary, null, 2)}`,
    `Existing chart blocks:\n${JSON.stringify(existingBlocks, null, 2)}`,
    "",
    "Propose the suggestions now. Output only JSON.",
  ].join("\n");

  const llmRes = await callLLM({
    tenantId: user.tenantId,
    kind: "suggest",
    reportId: params.id,
    userId: user.id,
    system,
    messages: [{ role: "user", content: userMsg }],
    maxTokens: 1024,
    responseFormat: "json",
  });
  if (llmRes.status === "failed") {
    if (llmRes.error?.includes("not configured")) {
      return NextResponse.json({ error: "AI not configured. Add a provider + key in Tenant Settings → LLM." }, { status: 503 });
    }
    return NextResponse.json({ error: llmRes.error || "AI request failed." }, { status: 502 });
  }
  const text = llmRes.text;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return NextResponse.json({ error: "Could not parse AI JSON.", raw: text }, { status: 502 });
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(jsonMatch[0]); }
  catch { return NextResponse.json({ error: "AI returned invalid JSON.", raw: text }, { status: 502 }); }

  const validated = ResponseSchema.safeParse(parsedJson);
  if (!validated.success) {
    return NextResponse.json({ error: "Suggestions failed validation.", issues: validated.error.issues, raw: parsedJson }, { status: 502 });
  }

  // Filter: drop any suggestion whose queryId doesn't exist or whose fields
  // aren't in that query's columns. Defends against hallucinated columns.
  const colsByQuery = Object.fromEntries(datasetSummary.map((d) => [d.queryId, new Set(d.columns.map((c) => c.name))]));
  const final = validated.data.suggestions.filter((s) => {
    const cols = colsByQuery[s.queryId];
    if (!cols) return false;
    if (!cols.has(s.xField)) return false;
    if (!s.yFields.every((y) => cols.has(y))) return false;
    return true;
  });

  return NextResponse.json({ suggestions: final });
}
