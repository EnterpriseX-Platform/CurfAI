import { describe, expect, it } from "vitest";
import { localizeBlock } from "./localize";
import type { Block } from "./schema";

const table = {
  id: "tb", type: "table", x: 0, y: 0, w: 6, h: 4,
  config: { queryId: "q", title: "Pipeline ที่ยังเปิดอยู่", columns: [{ key: "stage", label: "ขั้น" }, { key: "deals", label: "ดีล" }] },
  i18n: { en: { title: "Open pipeline", "columns.0.label": "Stage", "columns.1.label": "Deals" } },
} as unknown as Block;

describe("localizeBlock", () => {
  it("translates a field and the words inside a list", () => {
    const out = localizeBlock(table, "en") as any;
    expect(out.config.title).toBe("Open pipeline");
    expect(out.config.columns.map((c: any) => c.label)).toEqual(["Stage", "Deals"]);
    expect(out.config.columns[0].key).toBe("stage");
  });

  it("leaves the base language, and the block itself, untouched", () => {
    expect(localizeBlock(table, "th")).toBe(table);
    localizeBlock(table, "en");
    expect((table as any).config.columns[0].label).toBe("ขั้น");
  });

  it("fills a map the config doesn't have yet, but never invents a list item", () => {
    const chart = {
      id: "c", type: "chart", x: 0, y: 0, w: 6, h: 4,
      config: { queryId: "q", xField: "month", yFields: ["new_mrr"], referenceLines: [{ axis: "y", value: 0.75, label: "ขั้นต่ำ 75%" }] },
      i18n: { en: { "seriesLabels.new_mrr": "New customers", "referenceLines.0.label": "Floor 75%", "referenceLines.3.label": "x", "columns.0.label": "y" } },
    } as unknown as Block;
    const out = localizeBlock(chart, "en") as any;
    expect(out.config.seriesLabels).toEqual({ new_mrr: "New customers" });
    expect(out.config.referenceLines).toEqual([{ axis: "y", value: 0.75, label: "Floor 75%" }]);
    expect(out.config.columns).toBeUndefined();
  });
});

describe("withTranslations", () => {
  const build = (title: string, series: string, matchOn: string) => ({
    description: `${title} report`,
    pages: [{ blocks: [{ id: "c", config: { title, yFields: [series], rule: { value: matchOn } } }] }],
  });
  it("keeps the other build's words as translations, never the fields or values its data is read by", async () => {
    const { withTranslations } = await import("./localize");
    const out = withTranslations(build("ยอดขาย", "ยอดขาย", "เงินสด"), { en: build("Sales", "Sales", "Cash") }) as any;
    expect(out.descriptionI18n).toEqual({ en: "Sales report" });
    expect(out.pages[0]!.blocks[0]!.i18n).toEqual({ en: { title: "Sales", "seriesLabels.ยอดขาย": "Sales" } });
    expect(out.pages[0]!.blocks[0]!.config).toEqual({ title: "ยอดขาย", yFields: ["ยอดขาย"], rule: { value: "เงินสด" } });
  });
});

describe("report filters", () => {
  const param = (label: string, all: string, open: string) => ({
    name: "branch", label, type: "select" as const, required: false, default: "*",
    options: [{ value: "*", label: all }, { value: "สาขา 1", label: "สาขา 1" }, { value: "open", label: open }],
  });
  const report = (p: ReturnType<typeof param>) => ({ parameters: [p], pages: [{ blocks: [] }] });

  it("keep the other build's labels, paired by name and option value", async () => {
    const { withTranslations } = await import("./localize");
    const out = withTranslations(report(param("สาขา", "ทุกสาขา", "เปิด")), { en: report({ ...param("Branch", "All branches", "Open"), options: [{ value: "open", label: "Open" }, { value: "*", label: "All branches" }] }) }) as any;
    expect(out.parameters[0].i18n).toEqual({ en: { label: "Branch", "options.0.label": "All branches", "options.2.label": "Open" } });
  });

  it("read in the reader's language, and never change a name, value or default", async () => {
    const { localizeParameter, localizeReport } = await import("./localize");
    const p = { ...param("สาขา", "ทุกสาขา", "เปิด"), i18n: { en: { label: "Branch", "options.0.label": "All branches", name: "x", "options.0.value": "y", default: "z" } } };
    const out = localizeParameter(p, "en");
    expect(out.label).toBe("Branch");
    expect(out.options!.map((o) => o.label)).toEqual(["All branches", "สาขา 1", "เปิด"]);
    expect([out.name, out.default, out.options![0]!.value]).toEqual(["branch", "*", "*"]);
    expect(localizeParameter(p, "th")).toBe(p);
    const r = localizeReport({ version: 1, name: "r", parameters: [p], dataSources: [], pages: [{ id: "p", size: "A4", orientation: "portrait", blocks: [] }] } as any, "en");
    expect(r.parameters[0]!.label).toBe("Branch");
  });
});
