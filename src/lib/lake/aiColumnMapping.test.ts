import { describe, it, expect, vi, beforeEach } from "vitest";

const llm = vi.hoisted(() => vi.fn());
vi.mock("@/lib/llm", () => ({ callLLM: llm }));

import { aiSuggestMapping } from "./aiColumnMapping";
import { profileColumns } from "./columnMapping";
import { STANDARD_DATASETS } from "./standardDatasets";

const SALES = STANDARD_DATASETS.sales_lines;
// Headers no synonym list covers: the item and amount columns of a real-looking POS.
const rows = [
  { "วันที่": "01/09/2569", "รายการขาย": "ชาเย็น", "จน.": 2, "ยอดชำระ": 90, "หมายเหตุ": "ไม่หวาน" },
  { "วันที่": "02/09/2569", "รายการขาย": "กาแฟ", "จน.": 1, "ยอดชำระ": 55, "หมายเหตุ": "" },
];
const columns = profileColumns(rows);
const samples = Object.fromEntries(Object.keys(rows[0]).map((k) => [k, rows.map((r) => String((r as any)[k]))]));
const current = { sale_date: { column: "วันที่" }, branch: { value: "สยาม" } };
const answer = (mapping: Record<string, unknown>) => llm.mockResolvedValueOnce({ status: "ok", text: JSON.stringify({ mapping }) });
const run = () => aiSuggestMapping({ tenantId: "t1", userId: "u1", ds: SALES, columns, samples, current });

beforeEach(() => llm.mockReset());

describe("aiSuggestMapping", () => {
  it("takes the model's matches for columns no synonym covers", async () => {
    answer({ product: "รายการขาย", qty: "จน.", net_amount: "ยอดชำระ", sku: null });
    expect((await run()).suggestions).toEqual({
      product: { column: "รายการขาย" }, qty: { column: "จน." }, net_amount: { column: "ยอดชำระ" },
    });
    // Only the fields still open, and only the columns still free, are offered.
    const prompt = llm.mock.calls[0][0].messages[0].content as string;
    expect(prompt).not.toMatch(/- sale_date/);
    expect(prompt).not.toMatch(/"วันที่":/);
  });

  it("drops a column that isn't in the file, one named twice, and one whose values don't fit", async () => {
    answer({ product: "Menu Item", qty: "หมายเหตุ", net_amount: "ยอดชำระ", cost: "ยอดชำระ" });
    expect((await run()).suggestions).toEqual({ net_amount: { column: "ยอดชำระ" } });
  });

  it("never offers a column already in use", async () => {
    answer({ product: "วันที่" });
    expect((await run()).suggestions).toEqual({});
  });

  it("says when AI isn't available, and when its answer can't be read", async () => {
    llm.mockResolvedValueOnce({ status: "failed", error: "LLM not configured" });
    expect(await run()).toEqual({ suggestions: {}, error: "LLM not configured" });
    llm.mockResolvedValueOnce({ status: "ok", text: "here you go: product is รายการขาย" });
    expect((await run()).error).toMatch(/couldn't be read/);
  });

  it("doesn't call the model when there is nothing left to match", async () => {
    const all = Object.fromEntries(SALES.fields.map((f) => [f.key, { value: "x" }]));
    await aiSuggestMapping({ tenantId: "t1", userId: "u1", ds: SALES, columns, samples, current: all });
    expect(llm).not.toHaveBeenCalled();
  });
});
