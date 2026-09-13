/**
 * Which calls get the tenant's fast model. The split is the whole point:
 * Q&A-shaped kinds must route fast, Master Builder's design kinds must
 * not — a tenant who sets kimi-k3 for builds and kimi-k2 for Ask should
 * never see a build silently downgraded.
 */
import { describe, it, expect } from "vitest";
import { isFastKind } from "./index";

describe("isFastKind", () => {
  it("routes the grounded, short-output kinds to the fast model", () => {
    for (const k of ["ask", "ask_workspace", "ask.suggestions", "why", "caption", "operate_suggest", "operate.document_draft", "brief", "watcherSuggest", "suggest", "document_qa", "marketplace.describe", "forecast", "dashboard.recommend_kpis"]) {
      expect(isFastKind(k), k).toBe(true);
    }
  });

  it("keeps design work on the primary (reasoning) model", () => {
    for (const k of ["master_builder_design", "master_builder_plan", "master_builder_iterate", "master_builder_personalise", "master_builder_suggest", "generate", "regenerate", "instant_view", "operate.author", "autoCurf", "agent"]) {
      expect(isFastKind(k), k).toBe(false);
    }
  });
});
