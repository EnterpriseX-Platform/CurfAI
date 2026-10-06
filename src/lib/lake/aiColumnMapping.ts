/**
 * Ask the workspace's language model to match the fields header names
 * couldn't (columnMapping.ts's suggestMapping) — a POS that calls its item
 * column "รายการขาย" or its amount "ยอดชำระ", which no synonym list covers.
 *
 * Only on request (the mapping step's "Ask AI" button: it costs AI credits),
 * and only as a suggestion the user confirms. The model's answer is not
 * trusted: a column it names must exist in the file, not already be in use,
 * be named once, and hold values that fit the field (fits()) — anything
 * else is dropped, whatever the model said.
 */
import { callLLM } from "@/lib/llm";
import { fits, type ColumnMapping, type ColumnProfile } from "./columnMapping";
import type { StandardDataset } from "./standardDatasets";

/** What each field holds, for the model — the keys alone are too terse. */
const FIELD_MEANING: Record<string, string> = {
  sale_date: "date of the sale", sale_time: "time of day of the sale", branch: "branch / store / shop",
  receipt_id: "receipt, bill or order number", sku: "item or product code", product: "item or product name",
  category: "item category or group", qty: "quantity sold", unit_price: "price per unit",
  discount: "discount amount", net_amount: "net sales amount of the line", cost: "cost of the line",
  payment_method: "how it was paid", channel: "sales channel (in store, delivery app, online)",
  promo_code: "promotion or coupon", snapshot_date: "date the stock count is for", on_hand: "quantity in stock",
  stock_value: "value of the stock on hand", unit_cost: "cost per unit", reorder_point: "reorder level / minimum stock",
  lead_time_days: "days a delivery takes to arrive",
};

export async function aiSuggestMapping(opts: {
  tenantId: string;
  userId: string | null;
  ds: StandardDataset;
  columns: ColumnProfile[];
  samples: Record<string, string[]>;
  current: ColumnMapping;
}): Promise<{ suggestions: ColumnMapping; error?: string }> {
  const { ds, current } = opts;
  const used = new Set(Object.values(current).flatMap((s) => ("column" in s ? [s.column] : [])));
  const openFields = ds.fields.filter((f) => !current[f.key]);
  const freeColumns = opts.columns.filter((c) => !used.has(c.name) && c.nonEmpty > 0);
  if (openFields.length === 0 || freeColumns.length === 0) return { suggestions: {} };

  const system = [
    "You match the columns of a spreadsheet exported by a shop's point-of-sale system to the fields of a standard table.",
    "Reply with ONE JSON object and nothing else: {\"mapping\": {\"<field>\": \"<column name exactly as given>\" | null}}.",
    "Use null when no column clearly holds that field. Never invent a column name, never use one column for two fields, and prefer null over a guess.",
  ].join("\n");
  const user = [
    `Fields of the ${ds.tableName} table still to match:`,
    ...openFields.map((f) => `- ${f.key} (${f.type}): ${FIELD_MEANING[f.key] ?? f.key}`),
    "",
    "Columns of the file not matched yet, with sample values:",
    ...freeColumns.map((c) => `- ${JSON.stringify(c.name)}: ${JSON.stringify((opts.samples[c.name] ?? []).slice(0, 3))}`),
  ].join("\n");

  const resp = await callLLM({
    tenantId: opts.tenantId,
    userId: opts.userId,
    kind: "import.mapping",
    system,
    messages: [{ role: "user", content: user }],
    maxTokens: 600,
    temperature: 0,
    responseFormat: "json",
  });
  if (resp.status === "failed") return { suggestions: {}, error: resp.error ?? "AI is not available" };

  let parsed: unknown;
  try {
    const text = (resp.text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    parsed = JSON.parse(text);
  } catch {
    return { suggestions: {}, error: "The AI's answer couldn't be read." };
  }
  const answer = (parsed as { mapping?: Record<string, unknown> })?.mapping;
  if (!answer || typeof answer !== "object") return { suggestions: {} };

  const byName = new Map(freeColumns.map((c) => [c.name, c]));
  const taken = new Set<string>();
  const suggestions: ColumnMapping = {};
  for (const f of openFields) {
    const col = answer[f.key];
    if (typeof col !== "string") continue;
    const profile = byName.get(col);
    if (!profile || taken.has(col) || !fits(f, profile)) continue;
    suggestions[f.key] = { column: col };
    taken.add(col);
  }
  return { suggestions };
}
