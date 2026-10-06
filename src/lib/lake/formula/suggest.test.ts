import { beforeEach, describe, expect, it, vi } from "vitest";

const callLLM = vi.fn();
vi.mock("@/lib/llm", () => ({ callLLM: (...a: unknown[]) => callLLM(...a) }));

const { suggestFormula, columnName } = await import("./suggest");

const columns = [
  { name: "order_date", type: "date" }, { name: "store", type: "text" }, { name: "qty", type: "number" },
  { name: "revenue", type: "number" }, { name: "margin_pct", type: "number" }, { name: "unit cost", type: "number" },
];
const ok = (text: string) => ({ status: "ok", text, provider: "anthropic", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 });
const run = (description = "profit on each order") => suggestFormula({ tenantId: "t1", userId: "u1", description, columns });

beforeEach(() => callLLM.mockReset());

describe("suggestFormula — the model writes it, the compiler decides", () => {
  it("a formula that checks out comes back with its type and the columns it uses", async () => {
    callLLM.mockResolvedValueOnce(ok('```json\n{"formula": "ROUND(revenue * margin_pct, 2)", "name": "Gross Profit", "explanation": "Profit on each order."}\n```'));
    expect(await run()).toEqual({
      ok: true, formula: "ROUND(revenue * margin_pct, 2)", name: "gross_profit",
      explanation: "Profit on each order.", type: "number", uses: ["revenue", "margin_pct"],
    });
    expect(callLLM).toHaveBeenCalledTimes(1);
  });

  it("the model sees names and types, never a value, and the functions it may use", async () => {
    callLLM.mockResolvedValueOnce(ok('{"formula": "qty * 2", "name": "double_qty", "explanation": "x"}'));
    await run();
    const req = callLLM.mock.calls[0]![0];
    expect(req.messages[0].content).toContain("- revenue (number)\n");
    expect(req.messages[0].content).toContain("- [unit cost] (number)");
    expect(req.system).toContain("DAYS(end_date, start_date)");
    expect(req.kind).toBe("suggest.formula");
  });

  it("a formula that fails gets one more try, with the exact error", async () => {
    callLLM
      .mockResolvedValueOnce(ok('{"formula": "revenue - cost", "name": "profit", "explanation": "x"}'))
      .mockResolvedValueOnce(ok('{"formula": "revenue - [unit cost] * qty", "name": "profit", "explanation": "Revenue less cost."}'));
    const r = await run();
    expect(r).toMatchObject({ ok: true, formula: "revenue - [unit cost] * qty" });
    const retry = callLLM.mock.calls[1]![0].messages;
    // generateStructured's repair turn, quoting the compiler (the schema runs it).
    expect(retry.at(-1).content).toContain("formula — There's no column called cost");
    expect(retry.at(-2)).toMatchObject({ role: "assistant" });
  });

  it("after two failures it says why, and nothing is returned to save", async () => {
    callLLM.mockResolvedValue(ok('{"formula": "DAYS(TODAY(), order_date)", "name": "age", "explanation": "x"}'));
    const r = await run("days since the order");
    // The last problem's key and parts come along, for the editor to say it in the reader's language.
    expect(r).toEqual({ ok: false, code: "invalid", key: "changing_function", params: { fn: "TODAY" }, error: expect.stringMatching(/^Couldn't write a formula that checks out: TODAY\(\) changes on its own/) });
    expect(callLLM).toHaveBeenCalledTimes(2);
  });

  it("SQL from the model is refused like any other formula that isn't the language", async () => {
    callLLM.mockResolvedValue(ok('{"formula": "revenue; DROP TABLE orders", "name": "x", "explanation": "x"}'));
    expect(await run()).toMatchObject({ ok: false, code: "invalid" });
  });

  it("when the columns can't give it, the model's reason is passed on — no approximation", async () => {
    callLLM.mockResolvedValueOnce(ok('{"formula": null, "name": "", "explanation": "", "reason": "There is no list price column."}'));
    expect(await run("discount off list price")).toEqual({ ok: false, code: "declined", error: "There is no list price column." });
  });

  it("an answer that isn't JSON counts as a failed try", async () => {
    callLLM
      .mockResolvedValueOnce(ok("Sure! Here's the formula: revenue * margin_pct"))
      .mockResolvedValueOnce(ok('{"formula": "revenue * margin_pct", "name": "profit", "explanation": "x"}'));
    expect(await run()).toMatchObject({ ok: true });
    expect(callLLM).toHaveBeenCalledTimes(2);
  });

  it("a model that isn't reachable says so", async () => {
    callLLM.mockResolvedValueOnce({ status: "failed", text: "", error: "LLM not configured", provider: "anthropic", model: "", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0 });
    expect(await run()).toMatchObject({ ok: false, code: "failed" });
  });

  it("an empty description doesn't call the model", async () => {
    expect(await run("   ")).toMatchObject({ ok: false, code: "invalid" });
    expect(callLLM).not.toHaveBeenCalled();
  });
});

describe("columnName — a usable name that isn't taken", () => {
  it("cleans the model's name, or makes one from the description", () => {
    expect(columnName("Gross Profit %", "", columns)).toBe("gross_profit");
    expect(columnName("", "Profit on each order, please", columns)).toBe("profit_on_each_order");
    expect(columnName("2024 sales", "", columns)).toBe("c_2024_sales");
    expect(columnName("", "", columns)).toBe("new_column");
  });
  it("adds a number rather than reuse a column's name", () => {
    expect(columnName("revenue", "", columns)).toBe("revenue_2");
  });
});
