import { describe, it, expect } from "vitest";
import { redactSamples } from "./redaction";
import type { LakeColumn } from "./tables";

describe("redactSamples — a column's sample is a value from the table", () => {
  const schema: LakeColumn[] = [
    { name: "email", type: "text", sample: "ann@example.com", sensitivity: "pii", unredactedForRoles: ["support"] },
    { name: "salary", type: "number", sample: 91000, sensitivity: "financial", unredactedForRoles: [] },
    { name: "city", type: "text", sample: "Bangkok" },
  ];

  it("masks it wherever the column's values are masked for the viewer", () => {
    expect(redactSamples(schema, { id: "u", role: "member", roleSlugs: [] }).map((c) => c.sample)).toEqual(["•••••", "<redacted>", "Bangkok"]);
  });

  it("leaves it for a viewer who may see the column, and never changes the input", () => {
    expect(redactSamples(schema, { id: "u", role: "member", roleSlugs: ["support"] })[0]!.sample).toBe("ann@example.com");
    expect(redactSamples(schema, { id: "u", role: "admin", roleSlugs: [] })[1]!.sample).toBe(91000);
    expect(schema[0]!.sample).toBe("ann@example.com");
  });
});
