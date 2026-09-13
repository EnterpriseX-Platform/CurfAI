import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { decryptSecret } from "@/lib/secrets";
import { getDriver } from "@/lib/llm";
import { humanizeLlmError } from "@/lib/llm/humanizeError";
import { guardedFetch } from "@/lib/security/ssrfGuard";

const VALID_PROVIDERS = ["anthropic", "openai", "gemini", "openai-compatible"] as const;

const TestSchema = z.object({
  action: z.enum(["fetchModels", "testConnection"]),
  provider: z.enum(VALID_PROVIDERS),
  key: z.string().optional(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const body = await req.json().catch(() => null);
  const parsed = TestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  const { action, provider, key: newKey, model, baseUrl } = parsed.data;

  // Resolve API key
  let apiKey = newKey?.trim() || "";
  if (!apiKey) {
    const existing = await prisma.tenant.findUnique({
      where: { id: u.tenantId },
      select: { llmKeyEnc: true, anthropicKeyEnc: true },
    });
    let encKey = existing?.llmKeyEnc;
    if (!encKey && provider === "anthropic" && existing?.anthropicKeyEnc) {
      encKey = existing.anthropicKeyEnc;
    }
    if (encKey) {
      apiKey = decryptSecret(encKey) || "";
    }
  }

  if (!apiKey) {
    return NextResponse.json({ error: "API key is required to test connection." }, { status: 400 });
  }

  const resolveBaseUrl = () => {
    if (provider === "openai") return "https://api.openai.com/v1";
    if (provider === "openai-compatible") return (baseUrl || "").replace(/\/+$/, "");
    return "";
  };

  if (action === "fetchModels") {
    if (provider !== "openai" && provider !== "openai-compatible") {
      return NextResponse.json({ error: "Fetch models is only supported for OpenAI-compatible providers." }, { status: 400 });
    }
    const bUrl = resolveBaseUrl();
    if (!bUrl) return NextResponse.json({ error: "Base URL is required." }, { status: 400 });

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await guardedFetch(`${bUrl}/models`, {
        headers: { "Authorization": `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        let msg = await res.text();
        try { msg = JSON.parse(msg).error?.message || msg; } catch {}
        return NextResponse.json({ error: `Failed to fetch models: ${res.status} ${res.statusText} - ${msg}` }, { status: 400 });
      }

      const data = await res.json();
      if (!data.data || !Array.isArray(data.data)) {
         return NextResponse.json({ error: "Invalid response format from provider (expected a 'data' array)." }, { status: 400 });
      }

      const models = data.data.map((m: any) => m.id).filter(Boolean);
      return NextResponse.json({ models });
    } catch (e: any) {
      return NextResponse.json({ error: `Fetch failed: ${e?.message || "timeout or network error"}` }, { status: 400 });
    }
  }

  if (action === "testConnection") {
    const driver = getDriver(provider);
    if (!driver) return NextResponse.json({ error: "Unsupported provider for testing." }, { status: 400 });

    const bUrl = driver.needsBaseUrl ? resolveBaseUrl() : null;
    if (driver.needsBaseUrl && !bUrl) {
      return NextResponse.json({ error: "Base URL is required." }, { status: 400 });
    }
    const targetModel = (model || "").trim() || driver.defaultModel;

    // Calls the SAME driver.call() Master Builder's callLLM() dispatches to
    // — not a hand-rolled fetch — specifically WITH responseFormat: "json".
    // A plain-text "reply with ok" ping (the old version of this test) can
    // pass on a model that then 400s the moment Master Builder's real
    // requests ask for response_format: json_object; some OpenAI-compatible
    // sub-models (a "-code"-suffixed Kimi variant, for instance) accept
    // ordinary chat but reject JSON mode outright. Exercising the exact
    // request shape production sends is the only way "Test Connection"
    // passing actually means "this sub-model works for Master Builder."
    try {
      const resp = await driver.call(
        {
          tenantId: null,
          kind: "settings.testConnection",
          system: "You are a connectivity check. Respond with nothing but a JSON object.",
          messages: [{ role: "user", content: 'Reply with this exact json object: {"status":"ok"}' }],
          responseFormat: "json",
          // Generous budget on purpose: some reasoning-style models spend
          // tokens "thinking" before any JSON is emitted — a tight budget
          // here would flag a model as broken when 3500-token Master
          // Builder calls would've worked fine.
          maxTokens: 300,
          temperature: 0,
        },
        { apiKey, baseUrl: bUrl, model: targetModel },
      );

      if (resp.status === "failed") {
        const { message } = humanizeLlmError(resp.error);
        return NextResponse.json({ error: message }, { status: 400 });
      }

      // The HTTP call succeeding isn't the whole story in JSON mode — some
      // models return 200 with prose instead of the requested object, which
      // would just as surely break Master Builder's JSON.parse() downstream.
      let parsedJson = true;
      try { JSON.parse(resp.text); } catch { parsedJson = false; }

      return NextResponse.json({
        success: true,
        model: resp.model,
        jsonModeOk: parsedJson,
        warning: parsedJson
          ? // This check only proves the model CAN follow a trivial JSON
            // instruction — it can't fully predict a "thinking" model's
            // behavior on Master Builder's much larger real prompts, where
            // it may still exhaust its reasoning budget before answering.
            // That failure mode is inherent to fixed-budget reasoning
            // models, not something a lightweight test can rule out; if it
            // happens, Master Builder now surfaces it as a clear error
            // rather than a vague timeout.
            undefined
          : "The model responded, but not with valid JSON when asked to — Master Builder and other structured-output features may fail on this model even though the connection itself works.",
      });
    } catch (e: any) {
      return NextResponse.json({ error: `Test connection failed: ${e?.message || "timeout or network error"}` }, { status: 400 });
    }
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
