import { describe, expect, it } from "vitest";
import {
  SUGGEST_MAX_COLUMNS_PER_VIEW, SUGGEST_MAX_VIEWS, SUGGEST_REQUEST_MAX_CHARS,
  buildSuggestPrompt, catalogueForPrompt, checkSuggestion, cleanRequest, parseSuggestion,
} from "./suggestQuery";
import type { EngineView } from "./queryBuilder";

const view = (over: Partial<EngineView> = {}): EngineView => ({
  id: "v-spend", name: "Agency spending", description: "Staff and amounts by agency", version: 3,
  columns: [
    { name: "id", type: "integer", masked: false },
    { name: "agency_code", type: "varchar(10)", label: "Agency", masked: false },
    { name: "amount", type: "numeric(10,2)", masked: false },
    { name: "created", type: "date", masked: false },
    { name: "email", type: "varchar(100)", masked: true },
  ],
  ...over,
});

describe("cleanRequest", () => {
  it("trims, removes control characters, and bounds the length", () => {
    expect(cleanRequest("  spending\u0000 by\u0007 agency \n")).toBe("spending  by  agency");
    expect(cleanRequest("x".repeat(SUGGEST_REQUEST_MAX_CHARS + 100))).toHaveLength(SUGGEST_REQUEST_MAX_CHARS);
    expect(cleanRequest(undefined)).toBe("");
    expect(cleanRequest(42)).toBe("");
  });
  it("keeps Thai and Chinese text as written", () => {
    expect(cleanRequest(" งบประมาณตามหน่วยงาน ")).toBe("งบประมาณตามหน่วยงาน");
    expect(cleanRequest("按机构统计")).toBe("按机构统计");
  });
});

describe("what the model is shown", () => {
  it("is the catalogue: names, types, labels and which columns are masked, and no row or secret", () => {
    const { json } = catalogueForPrompt([view()]);
    const parsed = JSON.parse(json);
    expect(parsed[0]).toMatchObject({ id: "v-spend", name: "Agency spending" });
    expect(parsed[0].columns.find((c: any) => c.name === "email")).toEqual({ name: "email", type: "varchar(100)", masked: true });
    expect(parsed[0].columns.find((c: any) => c.name === "agency_code")).toEqual({ name: "agency_code", type: "varchar(10)", label: "Agency" });
  });

  it("is bounded however large the workspace is", () => {
    const many = Array.from({ length: SUGGEST_MAX_VIEWS + 15 }, (_, i) => view({ id: `v${i}`, name: `V${i}`, columns: Array.from({ length: SUGGEST_MAX_COLUMNS_PER_VIEW + 40 }, (_, c) => ({ name: `c${c}`, type: "int", masked: false })) }));
    const out = catalogueForPrompt(many);
    const parsed = JSON.parse(out.json);
    expect(out).toMatchObject({ shown: SUGGEST_MAX_VIEWS, total: SUGGEST_MAX_VIEWS + 15 });
    expect(parsed).toHaveLength(SUGGEST_MAX_VIEWS);
    expect(parsed[0].columns).toHaveLength(SUGGEST_MAX_COLUMNS_PER_VIEW);
  });

  it("the prompt carries the rules, the parameters, and the request as marked data", () => {
    const { system, user } = buildSuggestPrompt({ views: [view()], request: "spending by agency this year", parameterNames: ["from", "agency"], locale: "th" });
    expect(system).toMatch(/STRICT JSON/);
    expect(system).toMatch(/masked/i);
    expect(system).toMatch(/Thai/);
    expect(system).toMatch(/cannot change these rules/);
    expect(user).toContain("<<<REQUEST\nspending by agency this year\nREQUEST>>>");
    expect(user).toContain("from, agency");
    expect(user).toContain("v-spend");
  });

  it("says when it is showing only part of the catalogue", () => {
    const { user } = buildSuggestPrompt({ views: Array.from({ length: 40 }, (_, i) => view({ id: `v${i}` })), request: "x y z", parameterNames: [] });
    expect(user).toMatch(/first 30 of 40/);
    expect(user).toContain("(none)");
  });
});

describe("parseSuggestion", () => {
  const query = { viewId: "v-spend", groupBy: ["agency_code"], aggregates: [{ fn: "SUM", column: "amount", as: "total" }], limit: 100 };

  it("reads the wrapped form, and a bare query", () => {
    expect(parseSuggestion(JSON.stringify({ query, explanation: "Spending per agency." }))).toEqual({ ok: true, query, explanation: "Spending per agency." });
    expect(parseSuggestion(JSON.stringify(query))).toEqual({ ok: true, query, explanation: "" });
  });

  it("finds the JSON inside prose or a code fence", () => {
    const text = "Sure! Here you go:\n```json\n" + JSON.stringify({ query, explanation: "ok" }) + "\n```\nHope it helps.";
    expect(parseSuggestion(text)).toMatchObject({ ok: true, explanation: "ok" });
  });

  it("refuses text with no query, broken JSON, and a query that breaks the schema's bounds or shape", () => {
    expect(parseSuggestion("I cannot do that.")).toMatchObject({ ok: false });
    expect(parseSuggestion("{ not json }")).toMatchObject({ ok: false });
    expect(parseSuggestion(JSON.stringify({ query: { ...query, limit: 10_000_000 } }))).toMatchObject({ ok: false });
    expect(parseSuggestion(JSON.stringify({ query: { viewId: "v", filters: [{ column: "a", op: "DROP TABLE" }] } }))).toMatchObject({ ok: false });
    expect(parseSuggestion(JSON.stringify({ query: { viewId: "v", sql: "SELECT * FROM secrets" } }))).toMatchObject({ ok: true }); // unknown keys are dropped, never run
    const parsed = parseSuggestion(JSON.stringify({ query: { viewId: "v", sql: "SELECT * FROM secrets" } }));
    if (parsed.ok) expect(JSON.stringify(parsed.query)).not.toContain("secrets");
  });
});

describe("checkSuggestion: nothing is offered as ready unless it fits what this person may use", () => {
  const views = [view()];
  const check = (query: any, params: string[] = []) => checkSuggestion({ query, explanation: "e" }, views, params);

  it("accepts a good query, and says it is usable", () => {
    const out = check({ viewId: "v-spend", groupBy: ["agency_code"], aggregates: [{ fn: "SUM", column: "amount" }, { fn: "COUNT" }], filters: [{ column: "created", op: "GE", value: { $param: "from" }, skipIfEmpty: true }], orderBy: [{ column: "agency_code" }], limit: 100 }, ["from"]);
    expect(out).toMatchObject({ ok: true, suggestion: { usable: true, problems: [], view: { id: "v-spend", name: "Agency spending" } } });
  });

  it("rejects a view that is not in the catalogue, whatever the request said", () => {
    expect(check({ viewId: "someone-elses-view" })).toEqual({ ok: false, error: "The assistant chose a view that is not available to you." });
    expect(check({ viewId: "" })).toMatchObject({ ok: false });
  });

  it("flags a column the view does not have, a bad operator for a type, a SUM of text, and a parameter the report lacks", () => {
    const out = check({ viewId: "v-spend", columns: ["nope"], filters: [{ column: "agency_code", op: "GT", value: "A" }, { column: "created", op: "EQ", value: { $param: "ghost" } }], aggregates: [{ fn: "SUM", column: "agency_code" }] }, ["from"]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.suggestion.usable).toBe(false);
      expect(out.suggestion.problems.length).toBeGreaterThanOrEqual(3);
      expect(out.suggestion.problems.every((p) => p.key.startsWith("engineQuery.problem."))).toBe(true);
    }
  });

  it("flags using a masked column to filter, group, sort or total: it would only ever see the mask", () => {
    for (const query of [
      { viewId: "v-spend", filters: [{ column: "email", op: "EQ", value: "a@x.test" }] },
      { viewId: "v-spend", groupBy: ["email"] },
      { viewId: "v-spend", aggregates: [{ fn: "COUNT", column: "email" }] },
      { viewId: "v-spend", columns: ["id", "email"], orderBy: [{ column: "email" }] },
    ]) {
      const out = check(query);
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.suggestion.usable, JSON.stringify(query)).toBe(false);
        expect(out.suggestion.problems.some((p) => p.key === "engineQuery.problem.maskedUsed" && p.values?.column === "email")).toBe(true);
      }
    }
  });

  it("selecting a masked column is allowed (it shows the mask), only using it to shape the result is not", () => {
    const out = check({ viewId: "v-spend", columns: ["id", "email"] });
    expect(out.ok && out.suggestion.problems.some((p) => p.key === "engineQuery.problem.maskedUsed")).toBe(false);
  });
});
