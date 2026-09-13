/**
 * Regression tests for the LLM-assisted forecast wrapper (Roadmap Phase
 * 1.4). The contract that matters: ALWAYS fall back to the linear fit —
 * never throw, never return a wrong-length array — for every failure mode
 * a real model call can produce.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const callLLMMock = vi.fn();
vi.mock("@/lib/llm", () => ({ callLLM: (...args: unknown[]) => callLLMMock(...args) }));

const { projectValuesWithLLM } = await import("./llmForecast");

function jsonReply(points: number[]) {
  return { status: "ok", text: "```json\n" + JSON.stringify({ points }) + "\n```" };
}

describe("projectValuesWithLLM", () => {
  beforeEach(() => { callLLMMock.mockReset(); });

  it("uses the LLM's numbers when they parse and match the requested period count", async () => {
    callLLMMock.mockResolvedValue(jsonReply([110, 130, 150]));
    const out = await projectValuesWithLLM("t1", [10, 20, 30, 40, 50], 3);
    expect(out.source).toBe("llm");
    expect(out.values).toEqual([110, 130, 150]);
  });

  it("falls back to linear when the model call fails", async () => {
    callLLMMock.mockResolvedValue({ status: "failed", text: "", error: "no key configured" });
    const out = await projectValuesWithLLM("t1", [10, 20, 30, 40, 50], 3);
    expect(out.source).toBe("linear");
    expect(out.values).toHaveLength(3);
    // A perfectly linear 10..50 series projects 60, 70, 80.
    expect(out.values[0]).toBeCloseTo(60, 5);
    expect(out.values[2]).toBeCloseTo(80, 5);
  });

  it("falls back to linear when the response isn't valid JSON", async () => {
    callLLMMock.mockResolvedValue({ status: "ok", text: "sure, here's a forecast: about 60-ish" });
    const out = await projectValuesWithLLM("t1", [10, 20, 30, 40, 50], 3);
    expect(out.source).toBe("linear");
    expect(out.values).toHaveLength(3);
  });

  it("falls back to linear when the model returns the wrong number of points", async () => {
    callLLMMock.mockResolvedValue(jsonReply([110, 130])); // asked for 3, got 2
    const out = await projectValuesWithLLM("t1", [10, 20, 30, 40, 50], 3);
    expect(out.source).toBe("linear");
    expect(out.values).toHaveLength(3);
  });

  it("falls back to linear when the model returns a non-finite value", async () => {
    callLLMMock.mockResolvedValue({ status: "ok", text: '```json\n{"points":[110, "n/a", 150]}\n```' });
    const out = await projectValuesWithLLM("t1", [10, 20, 30, 40, 50], 3);
    expect(out.source).toBe("linear");
  });

  it("never calls the model for a degenerate (single-point) series", async () => {
    const out = await projectValuesWithLLM("t1", [42], 3);
    expect(callLLMMock).not.toHaveBeenCalled();
    expect(out.source).toBe("linear");
    expect(out.values).toEqual([]);
  });

  it("never calls the model for a too-short series (linear is just as good)", async () => {
    const out = await projectValuesWithLLM("t1", [10, 20], 3);
    expect(callLLMMock).not.toHaveBeenCalled();
    expect(out.source).toBe("linear");
    expect(out.values).toHaveLength(3);
  });

  it("skips the model entirely when there's no tenant to bill", async () => {
    const out = await projectValuesWithLLM(undefined, [10, 20, 30, 40, 50], 3);
    expect(callLLMMock).not.toHaveBeenCalled();
    expect(out.source).toBe("linear");
  });

  it("falls back to linear if callLLM itself throws", async () => {
    callLLMMock.mockRejectedValue(new Error("network blip"));
    const out = await projectValuesWithLLM("t1", [10, 20, 30, 40, 50], 3);
    expect(out.source).toBe("linear");
    expect(out.values).toHaveLength(3);
  });
});
