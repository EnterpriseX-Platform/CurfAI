import { describe, it, expect } from "vitest";
import { costByFeature, featureOf } from "./costByFeature";

describe("costByFeature", () => {
  it("reads the feature and the repair flag from a kind", () => {
    expect(featureOf("master_builder_design_staged.foundation.repair")).toEqual({ feature: "master_builder_design_staged", repair: true });
    expect(featureOf("brief")).toEqual({ feature: "brief", repair: false });
  });
  it("folds parts and repairs into one feature, with the repair share, cost per call and share of the total", () => {
    const out = costByFeature([
      { kind: "deep_ask_plan", calls: 3, micro: 600 },
      { kind: "deep_ask_plan.repair", calls: 1, micro: 200 },
      { kind: "deep_ask_answer", calls: 2, micro: 200 },
      { kind: "brief", calls: 10, micro: 1000 },
    ]);
    expect(out.map((f) => f.feature)).toEqual(["brief", "deep_ask_plan", "deep_ask_answer"]);
    const plan = out.find((f) => f.feature === "deep_ask_plan")!;
    expect(plan).toMatchObject({ calls: 4, micro: 800, repairMicro: 200, repairShare: 0.25, perCall: 200 });
    expect(out[0].shareOfTotal).toBeCloseTo(0.5);
  });
  it("does not divide by zero on an empty or free list", () => {
    expect(costByFeature([])).toEqual([]);
    expect(costByFeature([{ kind: "x", calls: 0, micro: 0 }])[0]).toMatchObject({ repairShare: 0, perCall: 0, shareOfTotal: 0 });
  });
});
