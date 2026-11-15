import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANNUAL_MONTHS, PLANS, THB_SEAT_PRICES, periodPrice, planForTier, priceEnvVar, seatPrices } from "./plans";
import { priceIdsForTier, tierForPriceId, variantForPriceId } from "./billing";

const growth = planForTier("growth");
const business = planForTier("business");

describe("baht and annual prices", () => {
  it("quotes fixed baht prices per seat, before VAT, for the plans sold per seat", () => {
    expect(seatPrices(growth, "thb")).toEqual(THB_SEAT_PRICES.growth);
    expect(seatPrices(business, "thb")).toEqual({ editor: 3_490, viewer: 520 });
    expect(seatPrices(growth, "usd")).toEqual({ editor: 49, viewer: 9 });
    expect(seatPrices(planForTier("community"), "thb")).toBeNull();
    expect(seatPrices(planForTier("enterprise"), "thb")).toBeNull();
  });

  it("prices a period from the seats that are billable (the editor floor, the free viewers)", () => {
    // Business: minimum 5 editors, no free viewers.
    expect(periodPrice(business, { editors: 3, viewers: 4 }, "thb", "month")).toBe(5 * 3_490 + 4 * 520);
    // Growth: 10 free viewers.
    expect(periodPrice(growth, { editors: 2, viewers: 12 }, "usd", "month")).toBe(2 * 49 + 2 * 9);
  });

  it("an annual plan costs ten months, in either currency", () => {
    expect(ANNUAL_MONTHS).toBe(10);
    const seats = { editors: 6, viewers: 3 };
    expect(periodPrice(business, seats, "thb", "year")).toBe(10 * periodPrice(business, seats, "thb", "month")!);
    expect(periodPrice(business, seats, "usd", "year")).toBe(10 * periodPrice(business, seats, "usd", "month")!);
  });

  it("has no price for a plan not sold in the currency", () => {
    expect(periodPrice(planForTier("community"), { editors: 1, viewers: 0 }, "thb", "month")).toBeNull();
  });
});

describe("Stripe price ids by currency and interval", () => {
  const saved: Record<string, string | undefined> = {};
  const ids: Record<string, string> = {
    STRIPE_PRICE_GROWTH_EDITOR: "price_g_e", STRIPE_PRICE_GROWTH_VIEWER: "price_g_v",
    STRIPE_PRICE_GROWTH_EDITOR_ANNUAL: "price_g_e_y", STRIPE_PRICE_GROWTH_VIEWER_ANNUAL: "price_g_v_y",
    STRIPE_PRICE_GROWTH_EDITOR_THB: "price_g_e_thb", STRIPE_PRICE_GROWTH_VIEWER_THB: "price_g_v_thb",
    STRIPE_PRICE_GROWTH_EDITOR_THB_ANNUAL: "price_g_e_thb_y", STRIPE_PRICE_GROWTH_VIEWER_THB_ANNUAL: "price_g_v_thb_y",
    STRIPE_PRICE_BUSINESS_EDITOR_THB: "price_b_e_thb", STRIPE_PRICE_BUSINESS_VIEWER_THB: "price_b_v_thb",
  };
  beforeEach(() => { for (const [k, v] of Object.entries(ids)) { saved[k] = process.env[k]; process.env[k] = v; } });
  afterEach(() => { for (const k of Object.keys(ids)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("names the environment variable for each variant", () => {
    expect(priceEnvVar("STRIPE_PRICE_GROWTH_EDITOR", "usd", "month")).toBe("STRIPE_PRICE_GROWTH_EDITOR");
    expect(priceEnvVar("STRIPE_PRICE_GROWTH_EDITOR", "usd", "year")).toBe("STRIPE_PRICE_GROWTH_EDITOR_ANNUAL");
    expect(priceEnvVar("STRIPE_PRICE_GROWTH_EDITOR", "thb", "month")).toBe("STRIPE_PRICE_GROWTH_EDITOR_THB");
    expect(priceEnvVar("STRIPE_PRICE_GROWTH_EDITOR", "thb", "year")).toBe("STRIPE_PRICE_GROWTH_EDITOR_THB_ANNUAL");
  });

  it("reads the pair for a currency and interval, USD monthly by default, and none when a variant isn't configured", () => {
    expect(priceIdsForTier("growth")).toEqual({ editor: "price_g_e", viewer: "price_g_v" });
    expect(priceIdsForTier("growth", { currency: "thb", interval: "year" })).toEqual({ editor: "price_g_e_thb_y", viewer: "price_g_v_thb_y" });
    expect(priceIdsForTier("business", { currency: "thb" })).toEqual({ editor: "price_b_e_thb", viewer: "price_b_v_thb" });
    expect(priceIdsForTier("business", { currency: "thb", interval: "year" })).toBeNull(); // annual baht isn't set up for Business here
    expect(priceIdsForTier("community")).toBeNull();
  });

  it("recognises any of our prices: its tier, seat kind, currency and interval", () => {
    expect(variantForPriceId("price_g_v_thb_y")).toEqual({ tier: "growth", seat: "viewer", currency: "thb", interval: "year" });
    expect(variantForPriceId("price_b_e_thb")).toEqual({ tier: "business", seat: "editor", currency: "thb", interval: "month" });
    expect(variantForPriceId("price_g_e")).toEqual({ tier: "growth", seat: "editor", currency: "usd", interval: "month" });
    expect(variantForPriceId("price_unknown")).toBeNull();
  });

  it("a subscription on any variant still names its tier (so a baht or annual customer isn't dropped to Community)", () => {
    for (const id of ["price_g_e", "price_g_v_y", "price_g_e_thb", "price_g_v_thb_y"]) expect(tierForPriceId(id), id).toBe("growth");
    expect(tierForPriceId("price_b_v_thb")).toBe("business");
    expect(tierForPriceId("nope")).toBeNull();
    expect(PLANS.length).toBeGreaterThan(0);
  });
});
