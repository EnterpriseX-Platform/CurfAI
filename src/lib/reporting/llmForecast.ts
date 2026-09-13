/**
 * LLM-assisted forecasting — Tier 4 `ai.forecast_llm` (Business).
 *
 * forecast.ts's OLS fit is a straight line, full stop. This wraps it with
 * an LLM pass that can read pattern the line can't — seasonality, plateaus,
 * accelerating/decelerating growth — while staying strictly additive: on
 * any failure (no key configured, model errors, malformed response, wrong
 * point count) this falls straight back to the same linear projection
 * forecast.ts already produces, so a caller never has to special-case "the
 * AI path didn't work."
 */
import { z } from "zod";
import { callLLM } from "@/lib/llm";
import { linearFit } from "./forecast";

const LlmForecastSchema = z.object({ points: z.array(z.number()).min(1) });

export type LlmForecastResult = { values: number[]; source: "llm" | "linear" };

/**
 * Project `periods` values past the end of `history` (oldest→newest, one
 * number per period). `values.length` is always either `periods` or 0
 * (degenerate input — fewer than 2 finite points) — never throws, never
 * returns a partial array.
 */
export async function projectValuesWithLLM(
  tenantId: string | undefined,
  history: number[],
  periods: number,
): Promise<LlmForecastResult> {
  const fit = linearFit(history);
  const linearValues = fit
    ? Array.from({ length: periods }, (_, k) => fit.slope * (history.length + k + 1) + fit.intercept)
    : [];
  if (linearValues.length === 0 || !tenantId) return { values: linearValues, source: "linear" };
  // Too short for an LLM read to plausibly beat a straight line — save the
  // call and the latency.
  if (history.filter((n) => Number.isFinite(n)).length < 3) return { values: linearValues, source: "linear" };

  const system = [
    "You are a forecasting assistant for a business analytics product. Given a historical numeric time series (oldest to newest, one value per period), project the next N periods.",
    "Look for trend AND pattern beyond a straight line — seasonality, cyclicality, plateaus, accelerating or decelerating growth — where the series actually supports it. Do not force a straight line onto data that isn't linear, and don't invent a pattern that isn't there.",
    'Return ONE JSON object inside a single ```json code block, nothing else: { "points": [<N numbers>] }',
    `Return exactly ${periods} numbers, in order, oldest projected period first.`,
  ].join("\n");
  const user = `Historical series (${history.length} periods, oldest to newest):\n${history.join(", ")}`;

  let resp;
  try {
    resp = await callLLM({
      tenantId, kind: "forecast",
      system, messages: [{ role: "user", content: user }],
      maxTokens: 300, responseFormat: "json",
    });
  } catch {
    return { values: linearValues, source: "linear" };
  }
  if (resp.status === "failed") return { values: linearValues, source: "linear" };

  const fence = /```json\s*([\s\S]+?)```/i.exec(resp.text);
  const candidate = fence ? fence[1] : resp.text;
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); } catch { return { values: linearValues, source: "linear" }; }

  const validated = LlmForecastSchema.safeParse(parsed);
  if (
    !validated.success ||
    validated.data.points.length !== periods ||
    validated.data.points.some((n) => !Number.isFinite(n))
  ) {
    return { values: linearValues, source: "linear" };
  }
  return { values: validated.data.points, source: "llm" };
}
