/**
 * retailMetrics — the figures worked out from sales_lines and inventory,
 * against a real (temporary) lake. The standard tables are written the way
 * an import writes them: every value as text.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";

const root = vi.hoisted(() => {
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "curf-retail-"));
  process.env.CURF_LAKE_DIR = dir;
  return dir as string;
});

vi.mock("@/lib/db", () => ({
  prisma: { lakeTable: { findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 1 })) } },
}));
vi.mock("@/ee", () => ({ ee: {} }));
const registerCreatedTable = vi.fn(async (o: any) => ({ id: o.name, name: o.name }));
vi.mock("./tableRegistration", () => ({ registerCreatedTable: (o: any) => registerCreatedTable(o) }));

import { forecastBranch, refreshRetailMetrics, retailCapabilities } from "./retailMetrics";
import { createOrReplaceTable, dropTable } from "./tables";
import { closeLake, openLake } from "./storage";
import { STANDARD_DATASETS, standardColumns } from "./standardDatasets";

let n = 0;
let user: any;
beforeEach(() => {
  n += 1;
  user = { id: "u1", tenantId: `retail${n}`, role: "admin", email: "a@b.c" };
  registerCreatedTable.mockClear();
});
afterAll(() => {
  for (let i = 1; i <= n; i++) closeLake(`retail${i}`);
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.CURF_LAKE_DIR;
});

const text = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? null : String(v)])));
/** A standard table as an import leaves it: every standard column present, text values. */
async function table(name: "sales_lines" | "inventory", given: Array<Record<string, unknown>>) {
  const cols = standardColumns(STANDARD_DATASETS[name]).map((c) => c.name);
  const rows = given.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
  await createOrReplaceTable({
    tenantId: user.tenantId, tableName: name, rows: text(rows), sourceKind: "upload",
    columnTypeOverrides: Object.fromEntries(Object.keys(rows[0]).map((k) => [k, "text"])),
  });
}
const all = (sql: string) => openLake(user.tenantId).prepare(sql).all() as any[];
const iso = (base: string, plus: number) => new Date(Date.parse(`${base}T00:00:00Z`) + plus * 86_400_000).toISOString().slice(0, 10);

/** One sales line per day for `days` days ending 2026-09-30. */
function daily(branch: string, sku: string, qty: number, days: number, extra: Record<string, unknown> = {}) {
  return Array.from({ length: days }, (_, i) => ({
    sale_date: iso("2026-09-30", -i), branch, receipt_id: `${branch}-${sku}-${i}`, sku, product: `Item ${sku}`,
    qty, net_amount: qty * 10, discount: null, cost: null, ...extra,
  }));
}

describe("sales_daily", () => {
  it("adds up each branch's day, counting receipts as orders", async () => {
    await table("sales_lines", [
      { sale_date: "2026-09-01", branch: "A", receipt_id: "r1", sku: "x", product: "X", qty: 2, net_amount: 100, discount: 5, cost: 60 },
      { sale_date: "2026-09-01", branch: "A", receipt_id: "r1", sku: "y", product: "Y", qty: 1, net_amount: 50, discount: null, cost: null },
      { sale_date: "2026-09-01", branch: "A", receipt_id: "r2", sku: "x", product: "X", qty: 1, net_amount: 50, discount: null, cost: 30 },
      { sale_date: "2026-09-01", branch: "B", receipt_id: null, sku: "x", product: "X", qty: 3, net_amount: 150, discount: null, cost: null },
    ]);
    await refreshRetailMetrics(user);
    expect(all("SELECT * FROM sales_daily ORDER BY branch")).toEqual([
      { date: "2026-09-01", weekday: 2, branch: "A", revenue: 200, items: 4, orders: 2, avg_ticket: 100, discount: 5, cost: 90 },
      // No receipt numbers: no orders to count, so they and the ticket read blank — a line
      // is not an order. No discount given reads blank too, not 0.
      { date: "2026-09-01", weekday: 2, branch: "B", revenue: 150, items: 3, orders: null, avg_ticket: null, discount: null, cost: null },
    ]);
    expect(registerCreatedTable).toHaveBeenCalledWith(expect.objectContaining({ name: "sales_daily", sourceConfig: { provenance: "retail-metrics" } }));
  });
});

describe("stock_status", () => {
  it("works out cover, run-out date, order quantity and status from the sales", async () => {
    await table("sales_lines", [
      ...daily("A", "fast", 2, 90),                       // 2 a day
      ...daily("A", "out", 1, 90),
      ...daily("A", "neg", 1, 90),
      ...daily("A", "rop", 1, 90),
      ...daily("A", "over", 0.05, 90),
      { sale_date: "2026-06-01", branch: "A", receipt_id: "old", sku: "stale", product: "Item stale", qty: 1, net_amount: 10, discount: null, cost: null },
    ]);
    await table("inventory", [
      { snapshot_date: "2026-09-30", branch: "A", sku: "fast", product: "Item fast", on_hand: 10, lead_time_days: 7, reorder_point: null, stock_value: null, unit_cost: 5 },
      { snapshot_date: "2026-09-30", branch: "A", sku: "out", product: "Item out", on_hand: 0, lead_time_days: null, reorder_point: null, stock_value: 0, unit_cost: null },
      { snapshot_date: "2026-09-30", branch: "A", sku: "neg", product: "Item neg", on_hand: -3, lead_time_days: null, reorder_point: null, stock_value: null, unit_cost: null },
      { snapshot_date: "2026-09-30", branch: "A", sku: "rop", product: "Item rop", on_hand: 30, lead_time_days: 1, reorder_point: 40, stock_value: null, unit_cost: null },
      { snapshot_date: "2026-09-30", branch: "A", sku: "over", product: "Item over", on_hand: 10, lead_time_days: null, reorder_point: null, stock_value: null, unit_cost: null },
      { snapshot_date: "2026-09-30", branch: "A", sku: "stale", product: "Item stale", on_hand: 5, lead_time_days: null, reorder_point: null, stock_value: null, unit_cost: null },
      { snapshot_date: "2026-09-30", branch: "A", sku: "never", product: "Item never", on_hand: 3, lead_time_days: null, reorder_point: null, stock_value: null, unit_cost: null },
      { snapshot_date: "2026-09-30", branch: "A", sku: "gone", product: "Item gone", on_hand: 0, lead_time_days: null, reorder_point: null, stock_value: null, unit_cost: null },
      // An older snapshot of the same branch is ignored.
      { snapshot_date: "2026-09-01", branch: "A", sku: "fast", product: "Item fast", on_hand: 999, lead_time_days: 7, reorder_point: null, stock_value: null, unit_cost: null },
    ]);
    await refreshRetailMetrics(user);
    const rows = Object.fromEntries(all("SELECT * FROM stock_status").map((r) => [r.sku, r]));
    expect(Object.keys(rows).sort()).toEqual(["fast", "gone", "neg", "never", "out", "over", "rop", "stale"]);

    expect(rows.fast).toMatchObject({
      label: "Item fast — A", on_hand: 10, stock_value: 50, avg_daily_sales: 2, days_cover: 5,
      runout_date: "2026-10-05", suggested_order_qty: 18, status: "reorder", age_bucket: "0-30",
    });
    expect(rows.out).toMatchObject({ status: "out", suggested_order_qty: 14 });
    // Oversold (negative on hand): no days of cover, and the order makes up the shortfall too.
    expect(rows.neg).toMatchObject({ status: "out", days_cover: 0, runout_date: null, suggested_order_qty: 17 });
    expect(rows.rop).toMatchObject({ status: "reorder", reorder_point: 40 });
    expect(rows.over).toMatchObject({ days_cover: 200, status: "overstock" });
    expect(rows.stale).toMatchObject({ last_sale_date: "2026-06-01", days_since_last_sale: 121, age_bucket: "91-180", status: "slow" });
    // Never sold, over 90+ days of sales history: a slow mover too.
    expect(rows.never).toMatchObject({ age_bucket: "no_sales", status: "slow" });
    expect(rows.gone).toMatchObject({ status: "inactive" });
  });

  it("uses what the stock file says about sales when there are no sales lines, and guesses nothing", async () => {
    await table("inventory", [
      { snapshot_date: "2026-09-21", branch: "17", sku: "p1", product: "Phone", on_hand: 1, avg_daily_sales: 0.0714, last_sold_date: "2026-09-09" },
      { snapshot_date: "2026-09-21", branch: "17", sku: "p2", product: "Case", on_hand: 4, avg_daily_sales: 0, last_sold_date: "2026-04-01" },
      { snapshot_date: "2026-09-21", branch: "17", sku: "p3", product: "Cable", on_hand: 9, avg_daily_sales: null, last_sold_date: null },
    ]);
    await refreshRetailMetrics(user);
    const rows = Object.fromEntries(all("SELECT * FROM stock_status").map((r) => [r.sku, r]));
    expect(rows.p1).toMatchObject({ avg_daily_sales: 0.071, days_cover: 14, status: "ok", days_since_last_sale: 12 });
    expect(rows.p2).toMatchObject({ status: "slow", age_bucket: "91-180" });
    expect(rows.p3).toMatchObject({ status: "no_sales_data", days_cover: null, suggested_order_qty: 0 });
    // No sales lines: no sales tables.
    expect(all("SELECT name FROM sqlite_master WHERE name IN ('sales_daily', 'sales_forecast')")).toEqual([]);
  });

  it("works on a stock table imported before the dataset had every column it has now", async () => {
    // As an import from before avg_daily_sales / last_sold_date existed left it.
    await createOrReplaceTable({
      tenantId: user.tenantId, tableName: "inventory", sourceKind: "upload",
      rows: [{ snapshot_date: "2026-09-21", branch: "17", sku: "p1", product: "Phone", on_hand: "2" }],
      columnTypeOverrides: { snapshot_date: "text", branch: "text", sku: "text", product: "text", on_hand: "text" },
    });
    await refreshRetailMetrics(user);
    expect(all("SELECT sku, on_hand, avg_daily_sales, status FROM stock_status")).toEqual([
      { sku: "p1", on_hand: 2, avg_daily_sales: null, status: "no_sales_data" },
    ]);
  });
});

describe("basket_pairs and item_ranking", () => {
  /** One line per item on a receipt, 10 baht each. */
  const receipt = (branch: string, id: string, items: string[], daysBack: number) =>
    items.map((sku) => ({ sale_date: iso("2026-09-30", -daysBack), branch, receipt_id: id, sku, product: `P-${sku}`, category: sku === "z" ? "Dog" : "Cat", qty: 1, net_amount: 10 }));

  it("counts pairs per receipt, with support, confidence and lift worked out by hand", async () => {
    const lines = [
      ...Array.from({ length: 10 }, (_, i) => receipt("A", `xy${i}`, ["x", "y"], i)),
      ...Array.from({ length: 5 }, (_, i) => receipt("A", `x${i}`, ["x"], i)),
      ...Array.from({ length: 5 }, (_, i) => receipt("A", `yz${i}`, ["y", "z"], i)),
      ...Array.from({ length: 5 }, (_, i) => receipt("A", `z${i}`, ["z"], i)),
      // Same receipt numbers at another branch are other receipts.
      ...Array.from({ length: 2 }, (_, i) => receipt("B", `xy${i}`, ["x", "y"], i)),
      // Only two receipts: too few to list.
      ...Array.from({ length: 2 }, (_, i) => receipt("A", `pq${i}`, ["p", "q"], i)),
      // A 60-item "receipt" is a bulk order, not a basket — no pairs from it.
      receipt("A", "bulk", Array.from({ length: 60 }, (_, i) => `w${i}`), 1),
      // Older than the window.
      receipt("A", "old", ["x", "z"], 120),
    ].flat();
    await table("sales_lines", lines);
    await refreshRetailMetrics(user);

    // 30 receipts in the window; x on 17, y on 17, z on 10.
    expect(all("SELECT * FROM basket_pairs")).toEqual([
      {
        label: "P-x + P-y", item_a: "x", product_a: "P-x", category_a: "Cat", item_b: "y", product_b: "P-y", category_b: "Cat", receipts_together: 12,
        support: 0.4, confidence_a_to_b: 0.706, confidence_b_to_a: 0.706, lift: 1.25,
      },
      {
        label: "P-y + P-z", item_a: "y", product_a: "P-y", category_a: "Cat", item_b: "z", product_b: "P-z", category_b: "Dog", receipts_together: 5,
        support: 0.1667, confidence_a_to_b: 0.294, confidence_b_to_a: 0.5, lift: 0.88,
      },
    ]);

    const rank = Object.fromEntries(all("SELECT * FROM item_ranking").map((r) => [r.item, r]));
    // z sells only at A (100 baht there); x sells at both (170 over 2 branches).
    expect(rank.z).toMatchObject({ rank: 1, branches_selling: 1, branch_share_pct: 50, revenue: 100, revenue_per_branch: 100, margin_pct: null });
    expect(rank.x).toMatchObject({ branches_selling: 2, branch_share_pct: 100, revenue: 170, revenue_per_branch: 85 });
    expect(rank.w0.rank).toBeGreaterThan(rank.x.rank);
  });

  it("is empty, not missing, when the sales have no receipt numbers", async () => {
    await table("sales_lines", daily("A", "x", 1, 10).map((r) => ({ ...r, receipt_id: null })));
    await refreshRetailMetrics(user);
    expect(all("SELECT COUNT(*) AS n FROM basket_pairs")).toEqual([{ n: 0 }]);
  });
});

describe("promo_performance", () => {
  it("compares daily sales of the promoted items with the days before the promotion", async () => {
    const day = (daysBack: number, extra: Record<string, unknown>) => ({
      sale_date: iso("2026-09-30", -daysBack), branch: "A", receipt_id: `r${daysBack}`, sku: "m", product: "Mango", qty: 1, ...extra,
    });
    await table("sales_lines", [
      // Data starts 40 days back: 26 days of 100 a day before the promotion…
      ...Array.from({ length: 26 }, (_, i) => day(40 - i, { net_amount: 100, cost: 50 })),
      // …a week of SEP10 at 180 a day (2 sold, 20 off, cost 100)…
      ...Array.from({ length: 7 }, (_, i) => day(14 - i, { qty: 2, net_amount: 180, discount: 20, cost: 100, promo_code: "SEP10" })),
      // …and back to normal.
      ...Array.from({ length: 8 }, (_, i) => day(7 - i, { net_amount: 100, cost: 50 })),
      // A promotion on the data's first day has nothing before it to compare with.
      { ...day(40, { net_amount: 5, cost: null, promo_code: "OPEN" }), sku: "n", product: "Nut", receipt_id: "open" },
    ]);
    await refreshRetailMetrics(user);
    const rows = Object.fromEntries(all("SELECT * FROM promo_performance").map((r) => [r.promo_code, r]));
    expect(rows.SEP10).toEqual({
      promo_code: "SEP10", start_date: "2026-09-16", end_date: "2026-09-22", days: 7, branches: 1, items: 1, lines: 7, qty: 14,
      revenue: 1260, discount: 140, margin: 560,
      daily_revenue_during: 180, daily_revenue_before: 100, baseline_days: 26, uplift_pct: 80,
    });
    // No cost on its line: no margin. Nothing before it: no uplift.
    expect(rows.OPEN).toMatchObject({ margin: null, baseline_days: null, daily_revenue_before: null, uplift_pct: null });
  });
});

describe("sales_forecast", () => {
  it("follows the weekday pattern — a branch closed on Mondays forecasts 0 for Mondays", () => {
    const rows = Array.from({ length: 35 }, (_, i) => {
      const date = iso("2026-09-30", -i);
      const monday = new Date(`${date}T00:00:00Z`).getUTCDay() === 1;
      return { date, branch: "A", revenue: monday ? 0 : 100, orders: monday ? 0 : 10 };
    }).filter((r) => r.revenue > 0);
    const f = forecastBranch(rows, 7);
    expect(f).toHaveLength(7);
    for (const d of f) expect(d.revenue).toBe(d.weekday === 1 ? 0 : 100);
    expect(f[0].date).toBe("2026-10-01");
  });

  it("isn't moved by one campaign day on that weekday", () => {
    // 28 days at 100, but one Wednesday (a 9.9 sale) at 1,000 and another closed.
    const rows = Array.from({ length: 28 }, (_, i) => {
      const date = iso("2026-09-30", -i);
      return { date, branch: "A", revenue: date === "2026-09-09" ? 1000 : date === "2026-09-16" ? 0 : 100, orders: 1 };
    });
    const wed = forecastBranch(rows, 7).find((d) => d.weekday === 3)!;
    expect(wed.revenue).toBe(100);
  });

  it("scales by the trend, held within ±25%", () => {
    const rows = Array.from({ length: 56 }, (_, i) => ({ date: iso("2026-09-30", -i), branch: "A", revenue: i < 28 ? 300 : 100, orders: 1 }));
    expect(forecastBranch(rows, 1)[0]).toMatchObject({ revenue: 375, trend: 1.25 });
  });

  it("forecasts no orders for sales that came without receipt numbers", () => {
    const rows = Array.from({ length: 28 }, (_, i) => ({ date: iso("2026-09-30", -i), branch: "A", revenue: 100, orders: null }));
    expect(forecastBranch(rows, 1)[0]).toMatchObject({ revenue: 100, orders: null });
  });

  it("waits for two weeks of history", () => {
    expect(forecastBranch([{ date: "2026-09-30", branch: "A", revenue: 100, orders: 1 }], 7)).toEqual([]);
  });

  it("is written per branch, and empty-but-present when no branch has enough history", async () => {
    await table("sales_lines", [{ sale_date: "2026-09-30", branch: "A", receipt_id: "r", sku: "x", product: "X", qty: 1, net_amount: 10, discount: null, cost: null }]);
    await refreshRetailMetrics(user);
    expect(all("SELECT * FROM sales_forecast")).toEqual([]);
    expect(all("PRAGMA table_info(sales_forecast)").map((c) => c.name)).toEqual(["date", "weekday", "branch", "forecast_revenue", "forecast_orders", "trend"]);

    await dropTable(user.tenantId, "sales_lines");
    await table("sales_lines", daily("A", "x", 1, 30));
    await refreshRetailMetrics(user);
    expect(all("SELECT COUNT(*) AS n, MIN(date) AS f FROM sales_forecast")).toEqual([{ n: 28, f: "2026-10-01" }]);
    // Two full refreshes: over the 5 s default when the whole suite runs at once.
  }, 20_000);
});

describe("sales_hourly, payment_daily and what the data has", () => {
  const line = (receipt_id: string, sale_time: string, payment_method: string, net_amount: number) =>
    ({ sale_date: "2026-09-01", branch: "A", receipt_id, sku: "x", product: "X", qty: 1, net_amount, sale_time, payment_method });

  it("adds up sales by hour, folds each POS's payment names into one per method, and keeps the rest as written", async () => {
    await table("sales_lines", [
      line("r1", "08:15", "เงินสด", 100),
      line("r2", "08:40", "Cash", 50),
      line("r3", "12:05", "QR PromptPay", 70),
      line("r4", "12:30", "พร้อมเพย์", 30),
      line("r5", "12:31", "VISA", 200),
      line("r6", "13:00", "TrueMoney Wallet", 20),
      line("r7", "13:10", "", 10),
      line("r8", "13:20", "Bitcoin", 5),
    ]);
    await refreshRetailMetrics(user);
    expect(all("SELECT hour, revenue, orders, items FROM sales_hourly ORDER BY hour")).toEqual([
      { hour: 8, revenue: 150, orders: 2, items: 2 },
      { hour: 12, revenue: 300, orders: 3, items: 3 },
      { hour: 13, revenue: 35, orders: 3, items: 3 },
    ]);
    expect(all("SELECT method, revenue, orders FROM payment_daily ORDER BY revenue DESC")).toEqual([
      { method: "card", revenue: 200, orders: 1 },
      { method: "cash", revenue: 150, orders: 2 },
      { method: "qr", revenue: 100, orders: 2 },
      { method: "ewallet", revenue: 20, orders: 1 },
      // Not given is its own row, so the shares add up to all sales.
      { method: null, revenue: 10, orders: 1 },
      { method: "Bitcoin", revenue: 5, orders: 1 },
    ]);
    expect(retailCapabilities(user.tenantId)).toEqual({ hasTime: true, hasPayment: true, hasCost: false, hasReceipts: true });
  });

  it("says so when the sales have no times or payment methods", async () => {
    await table("sales_lines", daily("A", "x", 1, 3));
    await refreshRetailMetrics(user);
    expect(all("SELECT COUNT(*) AS n FROM sales_hourly")).toEqual([{ n: 0 }]);
    expect(retailCapabilities(user.tenantId)).toEqual({ hasTime: false, hasPayment: false, hasCost: false, hasReceipts: true });
  });

  it("says so when the sales have no receipt numbers — a POS summary of items sold per day", async () => {
    // Two days, three item lines each, no receipt numbers (a blank one is no number either).
    await table("sales_lines", ["2026-09-29", "2026-09-30"].flatMap((sale_date) => ["x", "y", "z"].map((sku, i) => ({
      sale_date, branch: "A", receipt_id: i === 0 ? "" : null, sku, product: `Item ${sku}`, qty: 5, net_amount: 500,
      sale_time: `0${8 + i}:00`, payment_method: "Cash",
    }))));
    await refreshRetailMetrics(user);
    expect(retailCapabilities(user.tenantId).hasReceipts).toBe(false);
    expect(all("SELECT date, revenue, items, orders, avg_ticket FROM sales_daily ORDER BY date")).toEqual([
      { date: "2026-09-29", revenue: 1500, items: 15, orders: null, avg_ticket: null },
      { date: "2026-09-30", revenue: 1500, items: 15, orders: null, avg_ticket: null },
    ]);
    expect(all("SELECT DISTINCT orders FROM sales_hourly")).toEqual([{ orders: null }]);
    expect(all("SELECT DISTINCT orders FROM payment_daily")).toEqual([{ orders: null }]);
  });
});

describe("item_sales and item_by_time", () => {
  it("compares the last 28 days with the 28 before, only for a branch whose sales cover both", async () => {
    // A: 60 days — 1 a day until 28 days ago, 3 a day since. B: 20 days of 2 a day.
    const a = Array.from({ length: 60 }, (_, i) => ({
      sale_date: iso("2026-09-30", -i), branch: "A", receipt_id: `a${i}`, sku: "x", product: "Item x",
      qty: i < 28 ? 3 : 1, net_amount: i < 28 ? 30 : 10,
    }));
    await table("sales_lines", [...a, ...daily("B", "x", 2, 20)]);
    await refreshRetailMetrics(user);
    expect(all("SELECT branch, qty, revenue, days, qty_per_day, qty_prev, revenue_prev, full_compare FROM item_sales ORDER BY branch")).toEqual([
      { branch: "A", qty: 84, revenue: 840, days: 28, qty_per_day: 3, qty_prev: 28, revenue_prev: 280, full_compare: 1 },
      // Opened 20 days ago: sells per 20 days, and has nothing to compare with.
      { branch: "B", qty: 40, revenue: 400, days: 20, qty_per_day: 2, qty_prev: null, revenue_prev: null, full_compare: 0 },
    ]);
  });

  it("takes cost from the sales lines when every line has one, else from the stock count, and never from part of them", async () => {
    // x: every line has a cost. y: one line of seven has none → falls back to stock. z: no cost anywhere.
    // 14 days: the last 7 and the 7 before, at 2 a day, ฿20 a line.
    const lines = (sku: string, cost: (i: number) => number | null) => Array.from({ length: 14 }, (_, i) => ({
      sale_date: iso("2026-09-30", -i), branch: "A", receipt_id: `${sku}${i}`, sku, product: `Item ${sku}`, qty: 2, net_amount: 20, cost: cost(i),
    }));
    await table("sales_lines", [...lines("x", () => 8), ...lines("y", (i) => (i === 3 ? null : 6)), ...lines("z", () => null)]);
    await table("inventory", [
      { snapshot_date: "2026-09-30", branch: "A", sku: "y", product: "Item y", on_hand: 10, unit_cost: 2.5 },
      { snapshot_date: "2026-09-30", branch: "A", sku: "z", product: "Item z", on_hand: 10, unit_cost: null },
    ]);
    await refreshRetailMetrics(user);
    const rows = all("SELECT item, qty_7, revenue_7, cost_7, qty_prev7, revenue_prev7, cost_prev7, cost, cost_source FROM item_sales ORDER BY item");
    expect(rows).toEqual([
      { item: "x", qty_7: 14, revenue_7: 140, cost_7: 56, qty_prev7: 14, revenue_prev7: 140, cost_prev7: 56, cost: 112, cost_source: "sales" },
      // The week with the uncosted line uses the stock count (14 × ฿2.5); the week before has every cost.
      { item: "y", qty_7: 14, revenue_7: 140, cost_7: 35, qty_prev7: 14, revenue_prev7: 140, cost_prev7: 42, cost: 70, cost_source: "stock" },
      { item: "z", qty_7: 14, revenue_7: 140, cost_7: null, qty_prev7: 14, revenue_prev7: 140, cost_prev7: null, cost: null, cost_source: null },
    ]);
    expect(retailCapabilities(user.tenantId).hasCost).toBe(true);
  });

  it("keeps the best sellers by weekday and hour, and a sale with no time by weekday only", async () => {
    // 16 items on Wednesday 30 Sep at 08:05, item i selling (i + 1) × 10 — the smallest drops off.
    const lines: Array<Record<string, unknown>> = Array.from({ length: 16 }, (_, i) => ({
      sale_date: "2026-09-30", branch: "A", receipt_id: `r${i}`, sku: `s${i}`, product: `P${i}`, qty: 1, net_amount: (i + 1) * 10, sale_time: "08:05",
    }));
    lines.push({ sale_date: "2026-09-29", branch: "A", receipt_id: "t", sku: "s15", product: "P15", qty: 2, net_amount: 40, sale_time: null });
    await table("sales_lines", lines);
    await refreshRetailMetrics(user);
    const rows = all("SELECT item, rank, weekday, hour, qty FROM item_by_time ORDER BY rank, weekday");
    expect(new Set(rows.map((r) => r.item)).size).toBe(15);
    expect(rows.some((r) => r.item === "s0")).toBe(false);
    expect(rows.filter((r) => r.item === "s15")).toEqual([
      { item: "s15", rank: 1, weekday: 2, hour: null, qty: 2 },
      { item: "s15", rank: 1, weekday: 3, hour: 8, qty: 1 },
    ]);
  });
});
