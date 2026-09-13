import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { callLLM } from "@/lib/llm";

export async function POST(req: NextRequest) {
  try {
    const u = await requireUser(req);
    if (!u) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { reportName, dataset, locale } = body;

    if (!dataset || Object.keys(dataset).length === 0) {
      return NextResponse.json({ explanation: "No data available to summarize." });
    }

    // Convert dataset to a succinct string
    let dataContext = "";
    for (const [queryId, rows] of Object.entries(dataset)) {
      const dataRows = rows as any[];
      if (dataRows.length === 0) continue;
      
      const keys = Object.keys(dataRows[0]);
      dataContext += `\nDataset ID: ${queryId}\nColumns: ${keys.join(", ")}\n`;
      
      // Limit to 10 rows to avoid token explosion
      const sample = dataRows.slice(0, 10);
      dataContext += sample.map(r => Object.values(r).join(" | ")).join("\n");
      if (dataRows.length > 10) {
        dataContext += `\n...and ${dataRows.length - 10} more rows.`;
      }
    }

    const languageInstruction = locale === "th" ? "CRITICAL: You MUST write the summary entirely in THAI language (ภาษาไทย). Do not use English." 
                             : locale === "zh" ? "CRITICAL: You MUST write the summary entirely in Simplified Chinese (简体中文). Do not use English." 
                             : "Write the summary in English.";

    const systemPrompt = `You are a data analyst AI assistant.
Your task is to write a concise, professional 2-3 sentence executive summary of the provided data for a dashboard widget.
The data comes from a report named: "${reportName}".
Focus on key numbers, trends, or notable facts in the dataset.
Do not use technical jargon about rows, columns, or datasets. Just explain what the data means.
Keep it extremely brief and easy to read at a glance.

${languageInstruction}`;

    const res = await callLLM({
      tenantId: u.tenantId,
      kind: "ask",
      system: systemPrompt,
      messages: [{ role: "user", content: `Here is the data:\n${dataContext}` }],
      maxTokens: 150,
      temperature: 0.2,
    });

    if (res.error) {
      return NextResponse.json({ error: res.error }, { status: 500 });
    }

    return NextResponse.json({ explanation: res.text });

  } catch (error: any) {
    console.error("[explain] Error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
