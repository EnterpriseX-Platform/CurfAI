import { describe, it, expect } from "vitest";
import { csvField, csvLine, redactSecrets, safeCell } from "./exportFormat";

describe("csv", () => {
  it("quotes only what needs it and writes dates, objects and nulls predictably", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField(new Date("2026-11-13T00:00:00Z"))).toBe("2026-11-13T00:00:00.000Z");
    expect(csvField(10n)).toBe("10");
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"');
  });
  it("ends a line with CRLF", () => {
    expect(csvLine(["a", 1, null])).toBe("a,1,\r\n");
  });
  it("keeps a spreadsheet from running a cell as a formula", () => {
    expect(safeCell("=HYPERLINK(\"x\")")).toBe("'=HYPERLINK(\"x\")");
    expect(safeCell("+1")).toBe("'+1");
    expect(safeCell("-2")).toBe("'-2");
    expect(safeCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(safeCell("ordinary")).toBe("ordinary");
    expect(safeCell(null)).toBe("");
  });
});

describe("redactSecrets", () => {
  it("replaces secret-looking values at any depth and leaves the rest", () => {
    const out = redactSecrets({
      channel: "slack", webhookUrl: "https://hooks.example/abc", nested: { apiKey: "k", signingSecret: "s", note: "hello" },
      list: [{ token: "t", ok: 1 }], password: "", missing: null,
    }) as any;
    expect(out.channel).toBe("slack");
    expect(out.webhookUrl).toBe("[redacted]");
    expect(out.nested).toEqual({ apiKey: "[redacted]", signingSecret: "[redacted]", note: "hello" });
    expect(out.list).toEqual([{ token: "[redacted]", ok: 1 }]);
    expect(out.password).toBe(""); // nothing to hide
    expect(out.missing).toBeNull();
  });
  it("does not modify its input", () => {
    const input = { token: "t" };
    redactSecrets(input);
    expect(input.token).toBe("t");
  });
});
