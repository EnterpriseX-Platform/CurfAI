/**
 * The retail pack against real worked-out figures: every report it builds
 * passes the report schema, every query runs on the tables retailMetrics
 * writes (all branches and one branch), the numbers are the data's, and
 * each watcher points at a block whose query returns the column it watches.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";

const root = vi.hoisted(() => {
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "curf-retail-pack-"));
  process.env.CURF_LAKE_DIR = dir;
  return dir as string;
});

vi.mock("@/lib/db", () => ({
  prisma: { lakeTable: { findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 1 })) } },
}));
vi.mock("@/ee", () => ({ ee: {} }));
vi.mock("@/lib/lake/tableRegistration", () => ({ registerCreatedTable: vi.fn(async (o: any) => ({ id: o.name, name: o.name })) }));

import { ReportSchema } from "@/lib/reporting/schema";
import { refreshRetailMetrics, retailCapabilities } from "@/lib/lake/retailMetrics";
import { createOrReplaceTable } from "@/lib/lake/tables";
import { closeLake, openLake } from "@/lib/lake/storage";
import { STANDARD_DATASETS, standardColumns } from "@/lib/lake/standardDatasets";
import { retailPack, RETAIL_REPORTS } from "./pack";
import { retailBranches } from "./setup";
import { drillOnlyQueryIds } from "@/lib/reporting/drill";

/** A clicked value for each drill query's own parameter. */
const DRILL = { drill_item: "Latte", drill_method: "Cash", drill_promo: "P1" };

const user = { id: "u1", tenantId: "retailpack", role: "admin", email: "a@b.c" } as any;
const iso = (plus: number) => new Date(Date.parse("2026-09-30T00:00:00Z") + plus * 86_400_000).toISOString().slice(0, 10);

async function table(name: "sales_lines" | "inventory", given: Array<Record<string, unknown>>, tenantId: string = user.tenantId) {
  const cols = standardColumns(STANDARD_DATASETS[name]).map((c) => c.name);
  await createOrReplaceTable({
    tenantId, tableName: name, sourceKind: "upload",
    rows: given.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] == null ? null : String(r[c])]))),
    columnTypeOverrides: Object.fromEntries(cols.map((c) => [c, "text"])),
  });
}

beforeAll(async () => {
  // 70 days, two branches: สยาม sells 100/day (2 receipts, cash at 08:10 and QR at 15:20),
  // อารีย์ 50/day (1 receipt at 09:00, no payment method given).
  const lines = Array.from({ length: 70 }, (_, i) => [
    { sale_date: iso(-i), sale_time: "08:10", payment_method: "เงินสด", branch: "สยาม", receipt_id: `s${i}a`, sku: "a", product: "Latte", qty: 2, net_amount: 60 },
    { sale_date: iso(-i), sale_time: "15:20", payment_method: "QR PromptPay", branch: "สยาม", receipt_id: `s${i}b`, sku: "b", product: "Cake", qty: 1, net_amount: 40 },
    { sale_date: iso(-i), sale_time: "09:00", branch: "อารีย์", receipt_id: `a${i}`, sku: "a", product: "Latte", qty: 1, net_amount: 50 },
  ]).flat();
  await table("sales_lines", lines);
  await table("inventory", [
    { snapshot_date: iso(0), branch: "สยาม", sku: "a", product: "Latte", on_hand: 4, unit_cost: 10, lead_time_days: 3 },
    { snapshot_date: iso(0), branch: "สยาม", sku: "b", product: "Cake", on_hand: 500, unit_cost: 5 },
    { snapshot_date: iso(0), branch: "อารีย์", sku: "a", product: "Latte", on_hand: 0, unit_cost: 10 },
    { snapshot_date: iso(0), branch: "อารีย์", sku: "z", product: "Mug", on_hand: 7, unit_cost: 20 },
  ]);
  await refreshRetailMetrics(user);
});
afterAll(() => {
  closeLake(user.tenantId);
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.CURF_LAKE_DIR;
});

const pack = (locale: "en" | "th" | "zh" = "th") =>
  retailPack({ locale, hasSales: true, hasStock: true, branches: retailBranches(user.tenantId), ...retailCapabilities(user.tenantId) });
const def = (name: string, locale?: "en" | "th" | "zh") =>
  ReportSchema.parse(pack(locale).reports.find((r) => r.name === name)!.buildDefinition("lake1"));
function run(report: ReturnType<typeof def>, queryId: string, params: Record<string, unknown>, tenantId: string = user.tenantId) {
  const ds = report.dataSources.find((d) => d.id === queryId)!;
  const used = Object.fromEntries(Object.entries(params).filter(([k]) => ds.sql!.includes(`:${k}`)));
  return openLake(tenantId).prepare(ds.sql!).all(used) as any[];
}

describe("retailPack", () => {
  it("builds reports that pass the schema, in every language, with the branches from the data", () => {
    for (const locale of ["en", "th", "zh"] as const) {
      for (const r of pack(locale).reports) {
        const d = ReportSchema.parse(r.buildDefinition("lake1"));
        expect(d.dataSources.every((q) => q.dataSourceId === "lake1")).toBe(true);
        // Chain-wide reports (basket & promotions) have no branch picker.
        const branch = d.parameters.find((q) => q.name === "branch");
        if (r.name !== RETAIL_REPORTS.basket) expect(branch!.options!.map((o) => o.value)).toEqual(["ALL", "สยาม", "อารีย์"]);
      }
    }
    expect(def(RETAIL_REPORTS.stock, "th").pages[0].blocks[0].config).toMatchObject({ text: "สต็อกและการสั่งซื้อ" });
  });

  it("runs every query, for all branches and for one", () => {
    // The drill queries' own parameters are the clicked value (lib/reporting/drill.ts).
    for (const r of pack().reports) {
      const d = ReportSchema.parse(r.buildDefinition("lake1"));
      for (const q of d.dataSources) {
        for (const branch of ["ALL", "อารีย์"]) {
          expect(() => run(d, q.id, { branch, period: "7", growth: 10, ...DRILL }), `${r.name} ${q.id}`).not.toThrow();
        }
      }
    }
  });

  it("shows the data's own numbers", () => {
    const overview = def(RETAIL_REPORTS.overview);
    expect(run(overview, "q_kpi", { branch: "ALL", period: "7" })).toEqual([{
      revenue: 1050, revenue_prev: 1050, orders: 21, orders_prev: 21, avg_ticket: 50, avg_ticket_prev: 50,
    }]);
    expect(run(overview, "q_kpi", { branch: "อารีย์", period: "30" })[0]).toMatchObject({ revenue: 1500, orders: 30 });
    expect(run(overview, "q_rank", { period: "7" }).map((r) => [r.branch, r.revenue, r.growth_pct]))
      .toEqual([["สยาม", 700, 0], ["อารีย์", 350, 0]]);
    expect(run(overview, "q_day", { branch: "ALL" })).toEqual([{ revenue: 150, revenue_prev: 150 }]);

    const stock = def(RETAIL_REPORTS.stock);
    const reorder = run(stock, "q_reorder", { branch: "ALL" });
    // Latte at สยาม: 2 a day, 4 on hand, lead 3 + 7 safety days → order 16.
    // Out at อารีย์: 1 a day, no lead time given → the default 7 + 7 → 14.
    expect(reorder.map((r) => [r.branch, r.product, r.suggested_order_qty, r.status_label])).toEqual([
      ["อารีย์", "Latte", 14, "หมด"],
      ["สยาม", "Latte", 16, "ควรสั่ง"],
    ]);
    expect(run(stock, "q_slow", { branch: "ALL" }).map((r) => r.product)).toEqual(["Mug"]);

    // Click an item: its sales by branch, narrowed by the branch filter like the rest.
    expect(run(stock, "q_drill_item", { branch: "ALL", drill_item: "Latte" }).map((r) => Object.values(r)[0])).toEqual(["สยาม", "อารีย์"]);
    expect(run(stock, "q_drill_item", { branch: "อารีย์", drill_item: "Latte" })).toHaveLength(1);
    // Drill queries run on the click, never with the report.
    expect([...drillOnlyQueryIds(overview)].sort()).toEqual(["q_drill_days", "q_drill_pay"]);
    expect((overview.pages[0].blocks.find((b) => b.id === "c_rank")!.config as any).drillParam).toBe("branch");

    const plan = def(RETAIL_REPORTS.plan);
    const targets = run(plan, "q_targets", { branch: "ALL", growth: 10 });
    expect(targets.map((r) => [r.branch, r.last_7d, r.forecast_7d, r.target_7d])).toEqual([
      ["สยาม", 700, 700, 770],
      ["อารีย์", 350, 350, 385],
    ]);
  });

  it("gives every chart columns its query returns, named in the reader's language", () => {
    for (const locale of ["en", "th", "zh"] as const) {
      for (const r of pack(locale).reports) {
        const d = ReportSchema.parse(r.buildDefinition("lake1"));
        for (const b of d.pages[0].blocks.filter((x) => x.type === "chart" || x.type === "heatmap")) {
          const cfg = b.config as any;
          const rows = run(d, cfg.queryId, { branch: "ALL", period: "30", growth: 5 });
          expect(rows.length, `${locale} ${r.name} ${b.id}`).toBeGreaterThan(0);
          const fields = b.type === "chart" ? [cfg.xField, ...cfg.yFields]
            : cfg.mode === "tiles" ? [cfg.labelField, cfg.codeField, cfg.statusField, cfg.valueField]
            : [cfg.xField, cfg.yField, cfg.valueField];
          for (const f of fields) expect(Object.keys(rows[0]), `${locale} ${r.name} ${b.id}`).toContain(f);
        }
      }
    }
    // The legend reads the column name — Thai in a Thai report.
    const trend = def(RETAIL_REPORTS.overview, "th").pages[0].blocks.find((b) => b.id === "c_trend")!.config as any;
    expect(trend.yFields).toEqual(["ยอดขาย", "พยากรณ์"]);
  });

  it("points each watcher at a block whose query returns the watched column", () => {
    const p = pack();
    expect(p.watchers).toHaveLength(2);
    for (const w of p.watchers) {
      const d = def(w.reportName);
      const block = d.pages[0].blocks.find((b) => b.id === (w.config as any).blockId)!;
      const rows = run(d, (block.config as any).queryId, { branch: "ALL" });
      expect(rows.length, w.name).toBeGreaterThan(0);
      expect(Object.keys(rows[0])).toContain((w.config as any).metric);
    }
  });

  it("shows when things sell, what sells most, how customers pay, how branches compare, and when to order", () => {
    const overview = def(RETAIL_REPORTS.overview);
    // No discount in the data reads blank, not ฿0; 28 items on 21 orders in 7 days.
    expect(run(overview, "q_money", { branch: "ALL", period: "7" })).toEqual([{
      discount: null, discount_prev: null, discount_share: null, discount_share_prev: null, items_per_order: 1.33, items_per_order_prev: 1.33,
    }]);
    expect(run(overview, "q_pay", { branch: "ALL", period: "7" })).toEqual([
      { method_label: "เงินสด", "ยอดขาย": 420, share_pct: 40, orders: 7, avg_ticket: 60 },
      { method_label: "ไม่ระบุ", "ยอดขาย": 350, share_pct: 33.3, orders: 7, avg_ticket: 50 },
      { method_label: "QR / พร้อมเพย์", "ยอดขาย": 280, share_pct: 26.7, orders: 7, avg_ticket: 40 },
    ]);

    const insights = def(RETAIL_REPORTS.insights);
    const heat = run(insights, "q_heat_time", { branch: "ALL" });
    expect(heat).toHaveLength(7 * 3);
    expect(heat.slice(0, 3)).toEqual([
      { day: "อา.", hour: "08:00", "ยอดขายเฉลี่ยต่อวัน": 60 },
      { day: "อา.", hour: "09:00", "ยอดขายเฉลี่ยต่อวัน": 50 },
      { day: "อา.", hour: "15:00", "ยอดขายเฉลี่ยต่อวัน": 40 },
    ]);
    // Every item × hour, 0 where nothing sold — Latte (the best seller) first.
    expect(run(insights, "q_heat_item", { branch: "ALL" }).map((r) => [r.product, r.hour, r["ชิ้นต่อวัน"]])).toEqual([
      ["Latte", "08:00", 2], ["Latte", "09:00", 1], ["Latte", "15:00", 0],
      ["Cake", "08:00", 0], ["Cake", "09:00", 0], ["Cake", "15:00", 1],
    ]);
    expect(run(insights, "q_heat_item", { branch: "อารีย์" }).map((r) => [r.product, r.hour, r["ชิ้นต่อวัน"]]))
      .toEqual([["Latte", "09:00", 1], ["Cake", "09:00", 0]]);
    expect(run(insights, "q_best", { branch: "ALL" })).toEqual([
      { product: "Latte", category: null, qty: 84, revenue: 3080, share_pct: 73.3, qty_per_day: 3, change_pct: 0 },
      { product: "Cake", category: null, qty: 28, revenue: 1120, share_pct: 26.7, qty_per_day: 1, change_pct: 0 },
    ]);
    expect(run(insights, "q_top_units", { branch: "ALL" })).toEqual([
      { product: "Latte", "จำนวนที่ขาย (ชิ้น)": 84 }, { product: "Cake", "จำนวนที่ขาย (ชิ้น)": 28 },
    ]);
    // Sales are flat, so nothing's demand is rising.
    expect(run(insights, "q_rising", { branch: "ALL" })).toEqual([]);

    const plan = def(RETAIL_REPORTS.plan);
    expect(run(plan, "q_plan_kpi", { branch: "ALL", growth: 10 })).toEqual([{ tomorrow: 150, forecast_7d: 1050, target_7d: 1155, last_7d: 1050 }]);
    // Average of the branches: 75 a day, ฿50 a ticket.
    expect(run(plan, "q_bench", {}).map((r) => [r.branch, r.sales_per_day, r.sales_index, r.avg_ticket, r.ticket_index, r.items_per_order, r.orders_per_day, r.change_pct, r.upside_7d]))
      .toEqual([["สยาม", 100, 133, 50, 100, 1.5, 2, 0, 0], ["อารีย์", 50, 67, 50, 100, 1, 1, 0, 0]]);
    // At +10%: Latte at สยาม sells 2.2 a day with 4 on hand → 2.2 × (14 + 7) − 4 = 42.2 → 43, now;
    // at อารีย์ 1.1 a day with none → 23.1 → 24, now. Cake has 500 on hand — nothing to order.
    expect(run(plan, "q_orders", { branch: "ALL", growth: 10 }).map((r) => [r.branch, r.product, r.per_day_target, r.order_qty, r.order_by, r.runout_date]))
      .toEqual([["อารีย์", "Latte", 1.1, 24, "2026-09-30", null], ["สยาม", "Latte", 2.2, 43, "2026-09-30", "2026-10-01"]]);
  });

  it("groups the menu by units sold and margin per unit, with costs from the stock count", () => {
    const menu = def(RETAIL_REPORTS.menu);
    // Last 28 days. Latte: 84 sold for ฿3,080 at ฿10 a unit (stock) → margin ฿2,240, ฿26.67 a unit.
    // Cake: 28 sold for ฿1,120 at ฿5 → ฿980, ฿35 a unit. Average margin per unit ฿3,220 ÷ 112 = ฿28.75;
    // an even share of units is 1/2, so popular means at least 35% of them.
    expect(run(menu, "q_menu_kpi", { branch: "ALL" })).toEqual([{ star: 0, plowhorse: 1, puzzle: 1, dog: 0 }]);
    expect(run(menu, "q_menu", { branch: "ALL" }).map((r) => [r.product, r.grp_label, r.qty, r.mix_pct, r.price, r.unit_cost, r.unit_margin, r.margin_pct, r.margin]))
      .toEqual([
        ["Latte", "ตัวถ่วงเงียบๆ", 84, 75, 36.67, 10, 26.67, 72.7, 2240],
        ["Cake", "อัญมณีซ่อนเร้น", 28, 25, 40, 5, 35, 87.5, 980],
      ]);
    expect(run(menu, "q_menu_tiles", { branch: "ALL" }).map((r) => [r.product, r.status])).toEqual([["Latte", "warning"], ["Cake", "info"]]);
    expect(run(menu, "q_nocost", { branch: "ALL" })).toEqual([]);
    // One branch on its own: its one item is both popular and at the average margin — a star.
    expect(run(menu, "q_menu_kpi", { branch: "อารีย์" })).toEqual([{ star: 1, plowhorse: 0, puzzle: 0, dog: 0 }]);
  });

  it("leaves out what the data can't support", () => {
    const onlyStock = retailPack({ locale: "en", hasSales: false, hasStock: true, branches: [] });
    expect(onlyStock.reports.map((r) => r.name)).toEqual([RETAIL_REPORTS.stock]);
    const onlySales = retailPack({ locale: "th", hasSales: true, hasStock: false, branches: ["สยาม"] });
    expect(onlySales.reports.map((r) => r.name)).toEqual([RETAIL_REPORTS.overview, RETAIL_REPORTS.insights, RETAIL_REPORTS.plan, RETAIL_REPORTS.basket]);
    // No costs anywhere: no menu analysis.
    expect(onlySales.reports.map((r) => r.name)).not.toContain(RETAIL_REPORTS.menu);
    expect(onlySales.watchers).toEqual([]);
    const parsed = (name: string) => ReportSchema.parse(onlySales.reports.find((r) => r.name === name)!.buildDefinition("lake1"));
    // One branch: nothing to compare it with. No stock: no order plan.
    expect(parsed(RETAIL_REPORTS.plan).dataSources.map((d) => d.id)).toEqual(["q_drill_item", "q_plan_kpi", "q_targets", "q_forecast"]);
    // No payment methods in the data: no payment chart.
    expect(parsed(RETAIL_REPORTS.overview).dataSources.map((d) => d.id)).not.toContain("q_pay");
    // No times of sale: no weekday × hour heatmap, and the item heatmap goes by weekday.
    const insights = parsed(RETAIL_REPORTS.insights);
    expect(insights.dataSources.map((d) => d.id)).not.toContain("q_heat_time");
    expect((insights.pages[0].blocks.find((b) => b.id === "h_item")!.config as any).xField).toBe("day");
    const byDay = run(insights, "q_heat_item", { branch: "ALL" });
    expect(byDay).toHaveLength(2 * 7);
    expect(byDay[0]).toEqual({ product: "Latte", day: "อา.", "ชิ้นต่อวัน": 3 });
  });
});

/**
 * A POS that exports "items sold per day" has no receipts: nothing to count
 * orders from. The pack used to count each line as an order and showed
 * "104 orders, 2,558 a bill" on 13 daily summaries of 16 books (2026-09-30).
 */
describe("retailPack on sales without receipt numbers", () => {
  const shop = { ...user, tenantId: "retailsummary" };
  const mixed = { ...user, tenantId: "retailmixed" };
  // 10 days, two branches, two items a day each: 4 units for 400 at Fair, 2 units for 100 at Mall.
  const summary = (withReceipts: (branch: string) => boolean) => Array.from({ length: 10 }, (_, i) => [
    { sale_date: iso(-i), branch: "Fair", receipt_id: withReceipts("Fair") ? `f${i}` : null, sku: "a", product: "Novel", qty: 3, net_amount: 300 },
    { sale_date: iso(-i), branch: "Fair", receipt_id: withReceipts("Fair") ? `f${i}` : null, sku: "b", product: "Comic", qty: 1, net_amount: 100 },
    { sale_date: iso(-i), branch: "Mall", receipt_id: withReceipts("Mall") ? `m${i}` : null, sku: "a", product: "Novel", qty: 1, net_amount: 60 },
    { sale_date: iso(-i), branch: "Mall", receipt_id: withReceipts("Mall") ? `m${i}` : null, sku: "b", product: "Comic", qty: 1, net_amount: 40 },
  ]).flat();
  const packOf = (tenantId: string) =>
    retailPack({ locale: "en", hasSales: true, hasStock: false, branches: retailBranches(tenantId), ...retailCapabilities(tenantId) });
  const defOf = (tenantId: string, name: string) =>
    ReportSchema.parse(packOf(tenantId).reports.find((r) => r.name === name)!.buildDefinition("lake1"));

  beforeAll(async () => {
    await table("sales_lines", summary(() => false), shop.tenantId);
    await refreshRetailMetrics(shop);
    await table("sales_lines", summary((b) => b === "Mall"), mixed.tenantId);
    await refreshRetailMetrics(mixed);
  });
  afterAll(() => { closeLake(shop.tenantId); closeLake(mixed.tenantId); });

  it("shows units sold and the average price in place of orders and the average ticket", () => {
    expect(retailCapabilities(shop.tenantId).hasReceipts).toBe(false);
    const overview = defOf(shop.tenantId, RETAIL_REPORTS.overview);
    expect(run(overview, "q_kpi", { branch: "ALL", period: "7" }, shop.tenantId)).toEqual([{
      revenue: 3500, revenue_prev: 1500, items: 42, items_prev: 18, avg_price: 83.33, avg_price_prev: 83.33,
    }]);
    const kpis = overview.pages[0].blocks.filter((b) => b.type === "kpi");
    expect(kpis.map((b) => [b.id, (b.config as any).label])).toEqual([
      ["k_rev", "Sales"], ["k_items", "Units sold"], ["k_price", "Average price"], ["k_day", "Latest day's sales"],
      ["k_disc", "Discount given"], ["k_disc_share", "Discount, share of sales before discount"],
    ]);
    expect((overview.pages[0].blocks[0].config as any).subtitle).toBe("Every branch at once — sales and units sold against the period before");
    expect(run(overview, "q_rank", { period: "7" }, shop.tenantId)).toEqual([
      { branch: "Fair", revenue: 2800, items: 28, avg_price: 100, growth_pct: 133.3 },
      { branch: "Mall", revenue: 700, items: 14, avg_price: 50, growth_pct: 133.3 },
    ]);
  });

  it("never shows a figure that needs orders, in any report", () => {
    const perOrder = /order|ticket|upside/i;
    for (const r of packOf(shop.tenantId).reports) {
      const d = ReportSchema.parse(r.buildDefinition("lake1"));
      for (const b of d.pages[0].blocks) {
        const cfg = b.config as any;
        const shown = [cfg.valueField, cfg.compareField, ...(cfg.yFields ?? []), ...(cfg.columns ?? []).map((c: any) => c.key)].filter(Boolean);
        expect(shown.filter((f: string) => perOrder.test(f)), `${r.name} ${b.id}`).toEqual([]);
      }
      for (const q of d.dataSources) {
        const row = run(d, q.id, { branch: "ALL", period: "7", growth: 10, ...DRILL }, shop.tenantId)[0] ?? {};
        expect(Object.keys(row).filter((k) => perOrder.test(k)), `${r.name} ${q.id}`).toEqual([]);
      }
    }
    // Two branches still compare, on sales alone — and the method no longer explains a ticket.
    const plan = defOf(shop.tenantId, RETAIL_REPORTS.plan);
    expect(run(plan, "q_bench", {}, shop.tenantId)).toEqual([
      { branch: "Fair", sales_per_day: 400, sales_index: 160, change_pct: null },
      { branch: "Mall", sales_per_day: 100, sales_index: 40, change_pct: null },
    ]);
    expect((plan.pages[0].blocks.find((b) => b.id === "b_method")!.config as any).text).not.toMatch(/ticket/);
  });

  it("says what an empty forecast, pair list and promotion list are waiting for", () => {
    const plan = defOf(shop.tenantId, RETAIL_REPORTS.plan);
    // 10 days of sales: no forecast yet, and the table says when there will be one.
    expect(run(plan, "q_targets", { branch: "ALL", growth: 10 }, shop.tenantId)).toEqual([]);
    expect((plan.pages[0].blocks.find((b) => b.id === "t_targets")!.config as any).emptyText)
      .toBe("No forecast yet — a branch gets one once it has 14 days of sales.");
    expect((plan.pages[0].blocks.find((b) => b.id === "b_method")!.config as any).text).toContain("once it has 14 days of sales");
    const basket = defOf(shop.tenantId, RETAIL_REPORTS.basket);
    for (const [id, q] of [["t_bundles", "q_bundles"], ["t_pairs", "q_pairs"], ["t_promos", "q_promos"]] as const) {
      expect(run(basket, q, {}, shop.tenantId)).toEqual([]);
      expect((basket.pages[0].blocks.find((b) => b.id === id)!.config as any).emptyText, id).toMatch(/imported without/);
    }
  });

  it("divides a ticket by the sales of the days that have receipts, when only some do", () => {
    expect(retailCapabilities(mixed.tenantId).hasReceipts).toBe(true);
    const overview = defOf(mixed.tenantId, RETAIL_REPORTS.overview);
    // Mall has receipts (7 of them, 100 each); Fair's 2,800 came without and stays out of the ticket.
    expect(run(overview, "q_kpi", { branch: "ALL", period: "7" }, mixed.tenantId)[0])
      .toMatchObject({ revenue: 3500, orders: 7, avg_ticket: 100 });
    expect(run(overview, "q_money", { branch: "ALL", period: "7" }, mixed.tenantId)[0]).toMatchObject({ items_per_order: 2 });
    expect(run(overview, "q_rank", { period: "7" }, mixed.tenantId).map((r) => [r.branch, r.orders, r.avg_ticket]))
      .toEqual([["Fair", null, null], ["Mall", 7, 100]]);
    const plan = defOf(mixed.tenantId, RETAIL_REPORTS.plan);
    expect(run(plan, "q_bench", {}, mixed.tenantId).map((r) => [r.branch, r.avg_ticket, r.ticket_index, r.orders_per_day, r.upside_7d]))
      .toEqual([["Fair", null, null, null, null], ["Mall", 100, 100, 1, 0]]);
  });
});

describe("the retail pack in another language", () => {
  it("a report set up in Thai reads in English for an English reader, and still queries what it did", async () => {
    const { retailPack } = await import("./pack");
    const { localizeReport } = await import("@/lib/reporting/localize");
    const opts = { hasSales: true, hasStock: true, branches: ["A"], hasTime: true, hasPayment: true, hasCost: true, hasReceipts: true };
    const th = retailPack({ ...opts, locale: "th" }), en = retailPack({ ...opts, locale: "en" });
    th.reports.forEach((r, i) => {
      const def = r.buildDefinition("ds"), english = en.reports[i]!.buildDefinition("ds");
      const shown = localizeReport(def, "en");
      const titles = (d: any) => d.pages.flatMap((p: any) => p.blocks).map((b: any) => b.config.title ?? b.config.text ?? b.config.label ?? null);
      expect(titles(shown)).toEqual(titles(english));
      expect(shown.description).toBe(english.description);
      // Its filters too — the words, not the values a query is bound to.
      const filters = (d: any) => d.parameters.map((p: any) => [p.label, p.options?.map((o: any) => o.label)]);
      expect(filters(shown)).toEqual(filters(english));
      expect(shown.parameters.map((p: any) => p.options?.map((o: any) => o.value))).toEqual(def.parameters.map((p: any) => p.options?.map((o: any) => o.value)));
      // The fields a block reads stay the Thai build's — its SQL names them.
      const fields = (d: any) => d.pages.flatMap((p: any) => p.blocks).map((b: any) => JSON.stringify([b.config.yFields, b.config.valueField, b.config.columns?.map((c: any) => c.key)]));
      expect(fields(shown)).toEqual(fields(def));
    });
  });
});
