import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { featureGate } from "@/lib/featureGate";
import { callLLM, requireAiCreditsFor } from "@/lib/llm";
import { engineContextFor, httpStatusForEngine } from "@/lib/engine/dataSource";
import { EngineCatalogueError, loadCatalogue } from "@/lib/engine/catalogue";
import { buildSuggestPrompt, checkSuggestion, cleanRequest, parseSuggestion } from "@/lib/engine/suggestQuery";

export const dynamic = "force-dynamic";

const Body = z.object({
  dataSourceId: z.string().min(1).max(100),
  request: z.string().max(2000),
  parameters: z.array(z.string().min(1).max(100)).max(50).optional(),
  locale: z.enum(["en", "th", "zh"]).optional(),
});

/**
 * "Describe what you want": proposes an engine query for a person's goal in words. The model sees the catalogue of
 * views this person may use (names, types, which columns are masked for them) and never any data; what it returns
 * is checked in code against that catalogue before it is offered (lib/engine/suggestQuery.ts). Nothing is run.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const gate = await featureGate(user, "ai.suggest_charts");
  if (gate) return gate;
  const credits = await requireAiCreditsFor(user.tenantId);
  if (credits) return credits;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "dataSourceId and request are required." }, { status: 400 });
  const request = cleanRequest(parsed.data.request);
  if (request.length < 3) return NextResponse.json({ error: "Say what you want to see, in a few words." }, { status: 400 });

  const ctx = await engineContextFor(user, parsed.data.dataSourceId);
  if (ctx instanceof NextResponse) return ctx;

  let views;
  try {
    views = await loadCatalogue(ctx);
  } catch (e: any) {
    const status = e instanceof EngineCatalogueError ? httpStatusForEngine(e.engineStatus) : 502;
    return NextResponse.json({ error: e?.message ?? "The engine could not list its views." }, { status });
  }
  if (views.length === 0) return NextResponse.json({ error: "No published views are available to you on this engine yet." }, { status: 422 });

  const parameterNames = parsed.data.parameters ?? [];
  const prompt = buildSuggestPrompt({ views, request, parameterNames, locale: parsed.data.locale });
  const llm = await callLLM({
    tenantId: user.tenantId,
    userId: user.id,
    kind: "suggest",
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
    maxTokens: 1024,
    temperature: 0.2,
    responseFormat: "json",
  });
  if (llm.status === "failed") {
    if (llm.error?.includes("not configured")) {
      return NextResponse.json({ error: "AI is not configured. Add a provider and key in Tenant Settings → LLM." }, { status: 503 });
    }
    return NextResponse.json({ error: llm.error || "The AI request failed." }, { status: 502 });
  }

  const answer = parseSuggestion(llm.text);
  if (!answer.ok) return NextResponse.json({ error: answer.error }, { status: 502 });
  const checked = checkSuggestion(answer, views, parameterNames);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 502 });
  // Who used the assistant, on which engine and view, and whether it fitted. Not what they typed.
  recordAudit({ user, kind: "engine.suggest", target: ctx.dataSource.id, req, meta: { view: checked.suggestion.view.id, usable: checked.suggestion.usable } });
  return NextResponse.json({ suggestion: checked.suggestion });
}
