/**
 * The schema route rewrote LakeTable.schemaJson from bare inferColumns()
 * output, which has no `sensitivity` field — so any add/rename/drop/retype
 * silently un-redacted PII columns (reproduced live over HTTP before the
 * fix). These pin the merge that closes it.
 */
import { describe, it, expect } from "vitest";
import { mergeGovernanceMetadata, parseSchemaJson } from "./schemaGovernance";
import type { LakeColumn } from "./tables";

const tagged: LakeColumn[] = [
  { name: "name", type: "text" },
  { name: "email", type: "text", sensitivity: "pii", unredactedForRoles: ["finance"] },
  { name: "city", type: "text", syntheticHint: "fk:cities" },
];
// What inferColumns(sample) returns after a schema change: types + samples, no governance.
const inferred: LakeColumn[] = [
  { name: "name", type: "text", sample: "Ada" },
  { name: "email", type: "text", sample: "ada@example.com" },
  { name: "city", type: "text", sample: "London" },
];

describe("mergeGovernanceMetadata", () => {
  it("restores sensitivity, its role allowlist, and syntheticHint onto freshly inferred columns", () => {
    const out = mergeGovernanceMetadata(tagged, inferred);
    expect(out[1]).toMatchObject({ name: "email", sensitivity: "pii", unredactedForRoles: ["finance"], sample: "ada@example.com" });
    expect(out[2]).toMatchObject({ name: "city", syntheticHint: "fk:cities" });
    expect(out[0].sensitivity).toBeUndefined();
  });

  it("takes type/sample from the FRESH column — only governance comes from the old one", () => {
    const out = mergeGovernanceMetadata(
      [{ name: "amount", type: "text", sensitivity: "financial" }],
      [{ name: "amount", type: "number", sample: 42 }],
    );
    expect(out[0]).toMatchObject({ type: "number", sample: 42, sensitivity: "financial" });
  });

  it("leaves a newly added column exactly as inferred", () => {
    const out = mergeGovernanceMetadata(tagged, [...inferred, { name: "notes", type: "unknown", sample: null }]);
    expect(out[3]).toEqual({ name: "notes", type: "unknown", sample: null });
  });

  it("lets a tag follow its column through a rename, and doesn't leave it on the old name", () => {
    const afterRename: LakeColumn[] = [
      { name: "name", type: "text" },
      { name: "contact_email", type: "text", sample: "ada@example.com" },
      { name: "city", type: "text" },
    ];
    const out = mergeGovernanceMetadata(tagged, afterRename, { contact_email: "email" });
    expect(out[1]).toMatchObject({ name: "contact_email", sensitivity: "pii", unredactedForRoles: ["finance"] });
    expect(out.some((c) => c.name === "email")).toBe(false);
  });

  it("drops a dropped column's tags with the column", () => {
    const out = mergeGovernanceMetadata(tagged, [inferred[0], inferred[2]]);
    expect(out.map((c) => c.name)).toEqual(["name", "city"]);
    expect(out.every((c) => c.sensitivity === undefined)).toBe(true);
  });

  it("never mutates its inputs and doesn't alias the allowlist array", () => {
    const existing = structuredClone(tagged);
    const fresh = structuredClone(inferred);
    const out = mergeGovernanceMetadata(existing, fresh);
    expect(existing).toEqual(tagged);
    expect(fresh).toEqual(inferred);
    out[1].unredactedForRoles!.push("intruder");
    expect(existing[1].unredactedForRoles).toEqual(["finance"]);
  });

  it("is a no-op when nothing was ever tagged", () => {
    expect(mergeGovernanceMetadata([{ name: "a", type: "text" }], [{ name: "a", type: "number", sample: 1 }]))
      .toEqual([{ name: "a", type: "number", sample: 1 }]);
  });
});

describe("parseSchemaJson", () => {
  it("parses a valid array", () => {
    expect(parseSchemaJson(JSON.stringify(tagged))).toEqual(tagged);
  });
  it.each([["null", null], ["empty", ""], ["not json", "{oops"], ["an object, not an array", "{\"a\":1}"]])(
    "returns [] for %s rather than throwing", (_label, raw) => {
      expect(parseSchemaJson(raw as any)).toEqual([]);
    },
  );
});

import { attachSamples, buildSchemaAfterConversion } from "./schemaGovernance";

describe("attachSamples", () => {
  it("fills a missing sample from the first non-empty value, skipping null and empty string", () => {
    const out = attachSamples([{ name: "amount", type: "number" }], [{ amount: null }, { amount: "" }, { amount: 42 }, { amount: 7 }]);
    expect(out[0].sample).toBe(42);
  });
  it("keeps a sample the column already has", () => {
    const out = attachSamples([{ name: "a", type: "text", sample: "keep" }], [{ a: "other" }]);
    expect(out[0].sample).toBe("keep");
  });
  it("serialises a native Date (DuckDB TIMESTAMP) to ISO instead of leaving it to JSON", () => {
    const out = attachSamples([{ name: "at", type: "date" }], [{ at: new Date("2026-01-15T00:00:00.000Z") }]);
    expect(out[0].sample).toBe("2026-01-15T00:00:00.000Z");
  });
  it("carries a boolean 0/1 or true/false through as-is, and a bigint as a number", () => {
    const out = attachSamples(
      [{ name: "b", type: "boolean" }, { name: "n", type: "number" }],
      [{ b: 0, n: BigInt(9) }],
    );
    expect(out[0].sample).toBe(0);
    expect(out[1].sample).toBe(9);
  });
  it("leaves a column untouched when no row has a value for it", () => {
    expect(attachSamples([{ name: "x", type: "text" }], [{ x: null }])).toEqual([{ name: "x", type: "text" }]);
  });
  it("never mutates its inputs", () => {
    const cols = [{ name: "a", type: "text" as const }];
    attachSamples(cols, [{ a: "v" }]);
    expect(cols).toEqual([{ name: "a", type: "text" }]);
  });
});

describe("buildSchemaAfterConversion", () => {
  const existing = JSON.stringify([
    { name: "amount", type: "text", sensitivity: "financial", unredactedForRoles: ["finance"] },
    { name: "active", type: "text" },
  ]);
  it("takes the RESOLVED types (never re-infers), attaches samples, and keeps governance tags", () => {
    const out = buildSchemaAfterConversion(
      existing,
      [{ name: "amount", type: "number" }, { name: "active", type: "boolean" }],
      [{ amount: 1299, active: 1 }],
    );
    expect(out[0]).toMatchObject({ name: "amount", type: "number", sample: 1299, sensitivity: "financial", unredactedForRoles: ["finance"] });
    // A sample of 0/1 would have inferred "number"; the resolved type wins.
    expect(out[1]).toMatchObject({ name: "active", type: "boolean", sample: 1 });
  });
  it("copes with an empty or corrupt existing schemaJson", () => {
    expect(buildSchemaAfterConversion("{bad", [{ name: "a", type: "number" }], [{ a: 1 }])).toEqual([{ name: "a", type: "number", sample: 1 }]);
  });
});

import { withFormulaGovernance } from "./schemaGovernance";

describe("withFormulaGovernance — a formula column is masked wherever what it reads is", () => {
  const email: LakeColumn = { name: "email", type: "text", sensitivity: "pii", unredactedForRoles: ["analyst", "admin"] };
  const salary: LakeColumn = { name: "salary", type: "number", sensitivity: "financial", unredactedForRoles: ["admin"] };

  it("takes the tightest of every column it reads: most severe label, only the roles allowed on all", () => {
    const out = withFormulaGovernance([email, salary, { name: "x", type: "text", formula: 'LEFT(email, 3) & salary' }]);
    expect(out[2]).toMatchObject({ sensitivity: "financial", unredactedForRoles: ["admin"] });
  });

  it("follows formula columns built on formula columns", () => {
    const out = withFormulaGovernance([email, { name: "a", type: "text", formula: "LEFT(email, 3)" }, { name: "b", type: "text", formula: "UPPER(a)" }]);
    expect(out[2]).toMatchObject({ sensitivity: "pii", unredactedForRoles: ["analyst", "admin"] });
  });

  it("a tag set on it by hand is replaced; one reading only untagged columns carries none", () => {
    const out = withFormulaGovernance([{ name: "qty", type: "number" }, { name: "q2", type: "number", formula: "qty * 2", sensitivity: "secret", unredactedForRoles: [] }]);
    expect(out[1]).toEqual({ name: "q2", type: "number", formula: "qty * 2" });
  });

  it("one that no longer checks out is masked for everyone but admins", () => {
    const out = withFormulaGovernance([{ name: "q2", type: "number", formula: "gone * 2" }]);
    expect(out[0]).toMatchObject({ sensitivity: "secret", unredactedForRoles: [] });
  });

  it("mergeGovernanceMetadata re-derives it, so tagging a source column later reaches it", () => {
    const prior: LakeColumn[] = [{ name: "email", type: "text" }, { name: "a", type: "text", formula: "LEFT(email, 3)" }];
    const out = mergeGovernanceMetadata([{ ...prior[0]!, sensitivity: "pii", unredactedForRoles: [] }, prior[1]!], prior);
    expect(out[1]).toMatchObject({ sensitivity: "pii", unredactedForRoles: [] });
  });
});
