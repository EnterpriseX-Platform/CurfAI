import { describe, it, expect } from "vitest";
import { buildWaterfall } from "./Gauge";

describe("buildWaterfall", () => {
  it("draws a total row from zero, in English, Thai and Chinese", () => {
    for (const total of ["Total", "Subtotal", "รวม", "ยอดรวมปีนี้", "合计"]) {
      const out = buildWaterfall(
        [{ step: "Last year", v: 100 }, { step: "Cut", v: -30 }, { step: total, v: null }],
        "step",
        "v",
      );
      expect(out[2]).toMatchObject({ __kind: "total", __base: 0, __bar: 70 });
    }
  });

  it("draws an opening total at its own value and runs the steps from it", () => {
    // Live: Pet Lovers' "รวมเดือนก่อน → … → รวมเดือนล่าสุด" bridge drew last month as 0.
    const out = buildWaterfall(
      [{ step: "รวมเดือนก่อน", v: 1000 }, { step: "อาหารแมว", v: 50 }, { step: "ทรายแมว", v: -20 }, { step: "รวมเดือนล่าสุด", v: 1030 }],
      "step",
      "v",
    );
    expect(out.map((r) => [r.__kind, r.__base, r.__bar])).toEqual([["total", 0, 1000], ["delta", 1000, 50], ["delta", 1030, 20], ["total", 0, 1030]]);
  });

  it("reads a first row that names a level as the opening, not a gain", () => {
    // Live: the budget bureau's bridge opened on a green "+20.4 พันล." for "วงเงินที่ขอทั้งหมด".
    for (const opening of ["วงเงินที่ขอทั้งหมด", "ยอดยกมา", "Opening balance", "Previous month"]) {
      const out = buildWaterfall([{ step: opening, v: 100 }, { step: "Cut", v: -30 }], "step", "v");
      expect(out.map((r) => [r.__kind, r.__base, r.__bar])).toEqual([["total", 0, 100], ["delta", 70, 30]]);
    }
    // Only the first row: a later step mentioning a start is still a change.
    expect(buildWaterfall([{ step: "Base", v: 10 }, { step: "Opening of new store", v: 5 }], "step", "v")[1]!.__kind).toBe("delta");
  });

  it("keeps a step whose name only contains the word as a change", () => {
    const out = buildWaterfall([{ step: "Totally new", v: 5 }, { step: "งบรวมจังหวัด", v: 7 }], "step", "v");
    expect(out.map((r) => r.__kind)).toEqual(["delta", "delta"]);
  });
});

describe("a bridge that closes on a total", () => {
  it("opens on one, whatever its first label says", () => {
    const out = buildWaterfall(
      [{ step: "ยอดขาย 1–29 ส.ค.", v: 100 }, { step: "สาขาอารีย์", v: 10 }, { step: "สาขาบางนา", v: -4 }, { step: "รวม 1–29 ก.ย.", v: 106 }],
      "step", "v",
    );
    expect(out.map((r) => [r.__kind, r.__base, r.__bar])).toEqual([["total", 0, 100], ["delta", 100, 10], ["delta", 106, 4], ["total", 0, 106]]);
    // Without a closing total, the first row stays a change.
    expect(buildWaterfall([{ step: "Cats", v: 5 }, { step: "Dogs", v: 3 }, { step: "Fish", v: 1 }], "step", "v")[0]!.__kind).toBe("delta");
  });
});
