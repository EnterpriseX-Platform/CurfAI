import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdminOrEditor } from "@/lib/auth";
import { callLLM } from "@/lib/llm";
import { introspectTables } from "@/app/api/reports/generate/route";
import { TopKpiDefSchema } from "@/lib/reporting/schema";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  dataSourceId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }

  const ds = await prisma.dataSource.findFirst({
    where: { id: parsed.data.dataSourceId, tenantId: user.tenantId },
    select: { id: true, name: true, kind: true, connection: true, discoveredSchemaJson: true },
  });
  if (!ds) return NextResponse.json({ error: "Data source not found" }, { status: 404 });

  // 1. Fetch Schema
  const intro = await introspectTables(ds);
  const schemaBlock = intro.tables
    .map((t) => {
      const colList = t.columns.map((c) => `${c.name} ${c.type || "?"}`).join(", ");
      return `- ${t.name}(${colList})`;
    })
    .join("\n");

  if (!schemaBlock) {
    return NextResponse.json({ error: "No tables found in this data source." }, { status: 400 });
  }

  // 2. Ask LLM to generate 3 Top KPIs
  const systemPrompt = `You are Curf, an expert data analyst.
The user wants to add a "Top Bar" of 3 high-level business KPIs to their dashboard.
Review the following schema from their Data Source "${ds.name}":
${schemaBlock}

Generate exactly 3 SQL queries that compute the most important metrics (e.g. Total Sales, Active Users, Total Expenses).
Each query MUST return exactly ONE column and ONE row containing a numeric value.
IMPORTANT SQL RULES:
1. You MUST enclose any column or table names that contain spaces or special characters in double quotes (e.g., SELECT SUM("Sales Amount (THB)")).
2. Write valid standard SQL (SQLite / PostgreSQL compatible).
3. If format is "percent", the query MUST return a decimal fraction between 0 and 1 (e.g. 0.348 for 34.8%). Do NOT multiply by 100 in the query.

Output a JSON array of objects with the following keys:
- label: string (A short, punchy title, e.g. "Total Sales")
- description: string (One plain-language sentence explaining what this KPI measures, for a
  business user who cannot read SQL — e.g. "The total value of all approved budget lines."
  Never mention table names, column names, or SQL syntax.)
- sql: string (The SQL query to compute the value)
- format: string (Either "number", "currency", or "percent")

Only output the raw JSON array. No markdown blocks, no other text.`;

  try {
    const res = await callLLM({
      tenantId: user.tenantId,
      kind: "dashboard.recommend_kpis",
      system: systemPrompt,
      messages: [{ role: "user", content: "Generate 3 Top KPIs as JSON array." }],
      maxTokens: 1000,
      temperature: 0.2,
    });

    let rawJson = res.text.trim();
    if (rawJson.startsWith("```json")) rawJson = rawJson.slice(7);
    if (rawJson.startsWith("```")) rawJson = rawJson.slice(3);
    if (rawJson.endsWith("```")) rawJson = rawJson.slice(0, -3);

    const parsedJson = JSON.parse(rawJson);
    if (!Array.isArray(parsedJson)) throw new Error("Expected a JSON array");

    const kpis = parsedJson.map((k: any, i: number) => {
      return {
        id: `kpi_${Date.now()}_${i}`,
        label: k.label || "Metric",
        description: typeof k.description === "string" ? k.description : undefined,
        query: {
          id: `q_${Date.now()}_${i}`,
          name: "Top KPI",
          dataSourceId: ds.id,
          sql: k.sql,
        },
        format: k.format === "currency" || k.format === "percent" ? k.format : "number",
      };
    });

    return NextResponse.json({ kpis });
  } catch (e: any) {
    console.error("KPI recommendation failed:", e);
    return NextResponse.json({ error: "Failed to generate KPIs with AI" }, { status: 500 });
  }
}
