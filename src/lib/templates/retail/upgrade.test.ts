import { describe, expect, it } from "vitest";
import { upgradeFromPack, type PackReport } from "./upgrade";
import { retailPack, RETAIL_REPORTS } from "./pack";

const opts = { hasSales: true, hasStock: true, branches: ["A", "B"], hasTime: true, hasPayment: true, hasCost: true, hasReceipts: true };
const fresh = (name: string) => retailPack({ ...opts, locale: "th" }).reports.find((r) => r.name === name)!.buildDefinition("lake1") as unknown as PackReport;

/** The same report as a pack from before drills and translations made it. */
function older(r: PackReport): PackReport {
  const c = structuredClone(r);
  c.dataSources = c.dataSources.filter((d) => !d.id.startsWith("q_drill_"));
  delete c.descriptionI18n;
  for (const p of c.parameters ?? []) delete p.i18n;
  for (const b of c.pages.flatMap((p) => p.blocks)) {
    delete b.i18n;
    if (b.config) { delete b.config.drilldown; delete b.config.drillParam; delete b.config.drillField; }
  }
  return c;
}
const block = (r: PackReport, id: string) => r.pages.flatMap((p) => p.blocks).find((b) => b.id === id)!;

describe("upgradeFromPack", () => {
  it("gives an untouched older report everything the pack adds now", () => {
    for (const name of [RETAIL_REPORTS.overview, RETAIL_REPORTS.stock, RETAIL_REPORTS.basket]) {
      const now = fresh(name);
      const up = upgradeFromPack(older(now), now)!;
      expect(up, name).not.toBeNull();
      expect(up.pages, name).toEqual(now.pages);
      expect(up.parameters, name).toEqual(now.parameters);
      expect(up.descriptionI18n, name).toEqual(now.descriptionI18n);
      expect(up.dataSources.map((d) => d.id).sort(), name).toEqual(now.dataSources.map((d) => d.id).sort());
      // …and once it has, there's nothing more to do.
      expect(upgradeFromPack(up, now), name).toBeNull();
    }
  });

  it("leaves what the shop changed as they left it", () => {
    const now = fresh(RETAIL_REPORTS.stock);
    const old = older(now);
    // They renamed the order list, and pointed the slow list at their own query.
    block(old, "t_reorder").config!.title = "สั่งของด่วน";
    block(old, "t_slow").config!.queryId = "q_mine";
    // …and wrote their own English for the title block.
    block(old, "b_title").i18n = { en: { text: "Our stock" } };
    const up = upgradeFromPack(old, now)!;

    expect(block(up, "t_reorder").config!.title).toBe("สั่งของด่วน");
    expect(block(up, "t_reorder").i18n?.en?.title).toBeUndefined();
    // Its column headings are still the pack's, so they translate; and it drills.
    expect(block(up, "t_reorder").i18n?.en?.["columns.0.label"]).toBe("Item");
    expect(block(up, "t_reorder").config!.drilldown).toEqual(block(now, "t_reorder").config!.drilldown);
    // A block reading another query isn't the pack's block any more.
    expect(block(up, "t_slow")).toEqual(block(old, "t_slow"));
    expect(block(up, "b_title").i18n?.en?.text).toBe("Our stock");
  });
});
