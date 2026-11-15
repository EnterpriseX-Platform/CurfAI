import { describe, it, expect } from "vitest";
import { missingTranslation } from "./localize";
import type { Report } from "./schema";

const block = (id: string, config: Record<string, unknown>, i18n?: Record<string, Record<string, string>>) => ({ id, type: "kpi", x: 0, y: 0, w: 4, h: 3, config, ...(i18n ? { i18n } : {}) });
const report = (blocks: unknown[], extra: Record<string, unknown> = {}) =>
  ({ version: 1, name: "r", parameters: [], dataSources: [], pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks }], ...extra }) as unknown as Report;

describe("missingTranslation", () => {
  it("says 'none' once for a report with no text in that language", () => {
    const r = report([block("a", { label: "ยอดขาย" })]);
    expect(missingTranslation(r, r.pages[0]!.blocks[0]!, "en")).toBe("none");
  });

  it("flags only the blocks left out of a report that is translated elsewhere", () => {
    const r = report([block("a", { label: "ยอดขาย" }, { en: { label: "Sales" } }), block("b", { label: "กำไร" })]);
    const [a, b] = r.pages[0]!.blocks;
    expect(missingTranslation(r, a!, "en")).toBeNull();
    expect(missingTranslation(r, b!, "en")).toBe("partial");
  });

  it("ignores a block with no words, and a language the report does not use", () => {
    const r = report([block("a", { label: "ยอดขาย" }, { en: { label: "Sales" } }), block("d", {})]);
    expect(missingTranslation(r, r.pages[0]!.blocks[1]!, "en")).toBeNull();
    expect(missingTranslation(r, r.pages[0]!.blocks[0]!, "zh")).toBe("none");
  });

  it("counts a translated report name as the report being translated", () => {
    const r = report([block("a", { label: "ยอดขาย" })], { nameI18n: { en: "Sales" } });
    expect(missingTranslation(r, r.pages[0]!.blocks[0]!, "en")).toBe("partial");
  });
});
