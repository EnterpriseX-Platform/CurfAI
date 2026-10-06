/**
 * Retail figures worked out from the standard sales and stock tables
 * (standardDatasets.ts) — the numbers behind stock alerts, run-out dates,
 * slow movers, the branch dashboard, the sales forecast and the basket and
 * promotion analysis.
 *
 * Every figure is a fixed calculation over the workspace's own rows, done
 * here in SQL (and a little arithmetic for the forecast), and written to an
 * ordinary lake table. Reports, watchers, Ask and Master Builder read those
 * tables; nothing in them is estimated by a language model, so a number on
 * a report can always be traced back to the sales and stock rows it came
 * from. Rebuilt after every import into a standard table
 * (lib/lake/importJob.ts), each table swapped in whole (replaceTableFromSelect).
 *
 * "Today" is the data's own latest date — the last sale, the stock
 * snapshot — never the server clock, so re-running on the same data gives
 * the same answer and an old export reads as of its own date.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { tenantWhere, type CurfSessionUser } from "@/lib/auth";
import { bustLakeCacheForTenant } from "./bust";
import { lakeFileSize, openLake } from "./storage";
import { createOrReplaceTable, ensureTableColumns, lakeTableExists, replaceTableFromSelect, type LakeColumn } from "./tables";
import { STANDARD_DATASETS, standardColumns } from "./standardDatasets";
import { registerCreatedTable } from "./tableRegistration";

/** The tables this module writes. */
export const RETAIL_TABLES = {
  salesDaily: "sales_daily",
  stockStatus: "stock_status",
  salesForecast: "sales_forecast",
  basketPairs: "basket_pairs",
  itemRanking: "item_ranking",
  promoPerformance: "promo_performance",
  salesHourly: "sales_hourly",
  itemSales: "item_sales",
  itemByTime: "item_by_time",
  paymentDaily: "payment_daily",
} as const;

/** The rules behind the figures — one place to read (and change) them. */
export const RETAIL_RULES = {
  /** Sales rate = quantity sold over this many most recent days ÷ the days. */
  velocityDays: 28,
  /** Stock kept on top of what the delivery lead time needs. */
  safetyDays: 7,
  /** Lead time assumed when the stock file doesn't give one. */
  defaultLeadTimeDays: 7,
  /** No sale for this many days (with stock on hand) = slow mover. */
  slowMoverDays: 60,
  /** More than this many days of cover = overstock. */
  overstockDays: 120,
  /** Days of daily sales forecast per branch. */
  forecastDays: 28,
  /** A branch needs this much sales history before it gets a forecast. */
  forecastMinHistoryDays: 14,
  /** Basket pairs and the item ranking look at this many most recent days of sales. */
  basketDays: 90,
  /** A receipt with more different items than this isn't a shopper's basket. */
  basketMaxItems: 50,
  /** A pair needs to be on at least this many receipts to be listed. */
  basketMinReceipts: 3,
  /** Pairs kept, most frequent first. */
  basketMaxPairs: 5000,
  /** Items kept in the ranking. */
  itemRankingMax: 2000,
  /** A promotion is compared with this many days before it started. */
  promoBaselineDays: 28,
  /** Best sellers and when they sell: this many most recent days, against the same length before. */
  demandDays: 28,
  /** Items in the "when do the best sellers sell" heatmap, by sales. */
  heatmapItems: 15,
  /** Demand is rising when an item sold at least this many units in the recent window… */
  risingMinQty: 10,
  /** …and at least this much more (%) than in the window before. */
  risingMinPct: 20,
  /** The sales plan orders for this many days ahead (plus the safety days). */
  planDays: 14,
} as const;

export const PROVENANCE = "retail-metrics";

/** `description` goes on the table's catalog row — above all the period it
 *  covers, which Master Builder has to know to keep one page on one period;
 *  `valueLabels` on a code column's (see LakeColumn.valueLabels). */
type TableDef = {
  name: string; types: Record<string, LakeColumn["type"]>; description?: string;
  valueLabels?: Record<string, NonNullable<LakeColumn["valueLabels"]>>;
  formats?: Record<string, NonNullable<LakeColumn["format"]>>;
};

/** What each stock status code means — the retail pack's reports and the
 *  stock_status column's own labels both read it. */
export const RETAIL_STATUS_LABELS: Record<"en" | "th" | "zh", Record<string, string>> = {
  en: { out: "Out of stock", reorder: "Order now", slow: "Slow mover", overstock: "Overstock", inactive: "Inactive", no_sales_data: "No sales data", ok: "OK" },
  th: { out: "หมด", reorder: "ควรสั่ง", slow: "ขายไม่ออก", overstock: "สต็อกเกิน", inactive: "ไม่เคลื่อนไหว", no_sales_data: "ไม่มีข้อมูลการขาย", ok: "ปกติ" },
  zh: { out: "缺货", reorder: "需补货", slow: "滞销", overstock: "库存过多", inactive: "不活跃", no_sales_data: "无销售数据", ok: "正常" },
};

const itemKey = (alias: string) => `COALESCE(NULLIF(${alias}.sku, ''), ${alias}.product)`;
const num = (expr: string) => `CAST(${expr} AS REAL)`;
/** ceil(x) without SQLite's optional math extension. */
export const sqlCeil = (x: string) => `(CAST(${x} AS INTEGER) + ((${x}) > CAST(${x} AS INTEGER)))`;

// ---------------------------------------------------------------------------
// sales_daily — one row per branch per day
// ---------------------------------------------------------------------------

const SALES_DAILY: TableDef = {
  description: `Sales per branch per day, all of the sales history (revenue, items, orders, average ticket, discount, cost).`,
  name: RETAIL_TABLES.salesDaily,
  types: {
    date: "date", weekday: "number", branch: "text", revenue: "number", items: "number",
    orders: "number", avg_ticket: "number", discount: "number", cost: "number",
  },
};

// Orders are distinct receipts. A day imported without receipt numbers (a
// POS summary of items sold per day) has no orders to count and reads
// blank. It used to count each line as an order, so 13 daily summaries of
// 16 items read "104 orders, 2,558 a bill" (2026-09-30).
const RECEIPT = `NULLIF(receipt_id, '')`;
const ORDERS = `CASE WHEN COUNT(${RECEIPT}) > 0 THEN COUNT(DISTINCT ${RECEIPT}) END`;
const SALES_DAILY_SQL = `
  SELECT sale_date AS date,
         CAST(strftime('%w', sale_date) AS INTEGER) AS weekday,
         branch,
         ROUND(SUM(${num("net_amount")}), 2) AS revenue,
         SUM(${num("qty")}) AS items,
         ${ORDERS} AS orders,
         ROUND(SUM(${num("net_amount")}) / NULLIF(${ORDERS}, 0), 2) AS avg_ticket,
         -- A file with no discount column reads blank here, not 0.
         ROUND(SUM(${num("discount")}), 2) AS discount,
         ROUND(SUM(${num("cost")}), 2) AS cost
  FROM sales_lines
  WHERE sale_date IS NOT NULL
  GROUP BY sale_date, branch`;

// ---------------------------------------------------------------------------
// stock_status — the latest stock snapshot of every branch, one row per item
// ---------------------------------------------------------------------------

const STOCK_STATUS: TableDef = {
  valueLabels: { status: RETAIL_STATUS_LABELS },
  // Items a day, not baht — the name reads like money.
  formats: { avg_daily_sales: "number" },
  description: `The latest stock snapshot, one row per item per branch: on hand, average daily sales, days of cover, run-out date, reorder point, suggested order and a status code (ok / reorder / out / slow / overstock).`,
  name: RETAIL_TABLES.stockStatus,
  types: {
    label: "text", snapshot_date: "date", branch: "text", sku: "text", product: "text", category: "text",
    on_hand: "number", stock_value: "number", avg_daily_sales: "number", days_cover: "number",
    runout_date: "date", lead_time_days: "number", reorder_point: "number", suggested_order_qty: "number",
    last_sale_date: "date", days_since_last_sale: "number", age_bucket: "text", status: "text",
  },
};

/**
 * The status of one item, most urgent first:
 *   out        — none on hand, and it sells
 *   reorder    — at or under its reorder point, or fewer days of cover
 *                than the lead time plus the safety days
 *   slow       — stock on hand but no sale for slowMoverDays (or never,
 *                over at least that much sales history)
 *   overstock  — more than overstockDays of cover
 *   inactive   — none on hand and no sales either (likely discontinued)
 *   no_sales_data — nothing says how it sells; no guess is made
 *   ok         — everything else
 */
function stockStatusSql(hasSales: boolean): string {
  const r = RETAIL_RULES;
  const velocity = hasSales
    ? `
    ctx AS (
      SELECT MAX(sale_date) AS as_of,
             julianday(MAX(sale_date)) - julianday(MIN(sale_date)) + 1 AS history_days
      FROM sales_lines WHERE sale_date IS NOT NULL
    ),
    branch_first AS (SELECT branch, MIN(sale_date) AS first_day FROM sales_lines GROUP BY branch),
    vel AS (
      SELECT s.branch, ${itemKey("s")} AS item_key,
             SUM(CASE WHEN s.sale_date > date(ctx.as_of, '-${r.velocityDays} day') THEN ${num("s.qty")} ELSE 0 END)
               / (julianday(ctx.as_of) - julianday(MAX(date(ctx.as_of, '-${r.velocityDays - 1} day'), bf.first_day)) + 1) AS avg_daily,
             MAX(s.sale_date) AS last_sale
      FROM sales_lines s CROSS JOIN ctx JOIN branch_first bf ON bf.branch = s.branch
      GROUP BY s.branch, ${itemKey("s")}
    ),`
    : `
    ctx AS (SELECT NULL AS as_of, 0 AS history_days),
    vel AS (SELECT NULL AS branch, NULL AS item_key, NULL AS avg_daily, NULL AS last_sale WHERE 0),`;

  return `
    WITH ${velocity}
    snap AS (SELECT branch, MAX(snapshot_date) AS d FROM inventory GROUP BY branch),
    -- CROSS JOIN keeps inventory as the outer loop: one sequential pass over
    -- the table. Driven from snap, SQLite fetches every row through the
    -- (branch, date) index instead — a random read per row, 6x slower on a
    -- million-row stock file.
    inv AS (
      SELECT i.*, ${itemKey("i")} AS item_key
      FROM inventory i CROSS JOIN snap
      WHERE snap.branch = i.branch AND snap.d = i.snapshot_date
    ),
    m AS (
      SELECT inv.snapshot_date, inv.branch, inv.sku, inv.product, inv.category,
             ${num("inv.on_hand")} AS oh,
             COALESCE(${num("inv.stock_value")}, ${num("inv.on_hand")} * ${num("inv.unit_cost")}) AS value,
             COALESCE(vel.avg_daily, ${num("inv.avg_daily_sales")}) AS avg_daily,
             COALESCE(vel.last_sale, inv.last_sold_date) AS last_sale,
             COALESCE(${num("inv.lead_time_days")}, ${r.defaultLeadTimeDays}) AS lead,
             ${num("inv.reorder_point")} AS rop,
             vel.item_key IS NOT NULL AS in_sales,
             (SELECT history_days FROM ctx) AS history_days
      FROM inv LEFT JOIN vel ON vel.branch = inv.branch AND vel.item_key = inv.item_key
    ),
    d AS (
      SELECT m.*,
             -- Negative stock (sold before it was received, common in ERP exports)
             -- is no stock: 0 days of cover, and the order makes up the shortfall.
             CASE WHEN avg_daily > 0 THEN MAX(oh, 0) / avg_daily END AS cover,
             CASE WHEN last_sale IS NOT NULL THEN CAST(julianday(snapshot_date) - julianday(last_sale) AS INTEGER) END AS since
      FROM m
    )
    SELECT COALESCE(product, sku) || ' — ' || branch AS label,
           snapshot_date, branch, sku, product, category,
           oh AS on_hand,
           ROUND(value, 2) AS stock_value,
           ROUND(avg_daily, 3) AS avg_daily_sales,
           ROUND(cover, 1) AS days_cover,
           CASE WHEN cover IS NOT NULL AND oh > 0 THEN date(snapshot_date, '+' || CAST(cover AS INTEGER) || ' day') END AS runout_date,
           lead AS lead_time_days,
           rop AS reorder_point,
           CASE WHEN avg_daily > 0 AND avg_daily * (lead + ${r.safetyDays}) - oh > 0
                THEN ${sqlCeil(`avg_daily * (lead + ${r.safetyDays}) - oh`)} ELSE 0 END AS suggested_order_qty,
           last_sale AS last_sale_date,
           since AS days_since_last_sale,
           CASE WHEN since IS NULL THEN 'no_sales'
                WHEN since <= 30 THEN '0-30' WHEN since <= 60 THEN '31-60' WHEN since <= 90 THEN '61-90'
                WHEN since <= 180 THEN '91-180' ELSE '181+' END AS age_bucket,
           CASE
             WHEN oh <= 0 AND COALESCE(avg_daily, 0) > 0 THEN 'out'
             WHEN oh <= 0 THEN 'inactive'
             WHEN rop IS NOT NULL AND oh <= rop THEN 'reorder'
             WHEN cover IS NOT NULL AND cover <= lead + ${r.safetyDays} THEN 'reorder'
             WHEN since IS NOT NULL AND since >= ${r.slowMoverDays} THEN 'slow'
             WHEN since IS NULL AND ${hasSales ? `NOT in_sales AND history_days >= ${r.slowMoverDays}` : "0"} THEN 'slow'
             WHEN avg_daily IS NULL AND since IS NULL THEN 'no_sales_data'
             WHEN cover IS NOT NULL AND cover > ${r.overstockDays} THEN 'overstock'
             ELSE 'ok'
           END AS status
    FROM d`;
}

// ---------------------------------------------------------------------------
// sales_forecast — next forecastDays of revenue and orders per branch
// ---------------------------------------------------------------------------

const SALES_FORECAST: TableDef = {
  description: `Forecast revenue and orders per branch for the next ${RETAIL_RULES.forecastDays} days.`,
  name: RETAIL_TABLES.salesForecast,
  types: { date: "date", weekday: "number", branch: "text", forecast_revenue: "number", forecast_orders: "number", trend: "number" },
};

/** `orders` is blank for a day imported without receipt numbers. */
type DailyRow = { date: string; branch: string; revenue: number; orders: number | null };

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/**
 * The typical same weekday over the last four weeks — the middle of the
 * four (the mean of the middle two), so one campaign day (a 9.9 sale) or
 * one day closed doesn't move every forecast for that weekday — scaled by the trend
 * (the last four weeks against the four before, held within ±25% so one
 * odd month can't run away with it). A branch closed on Mondays forecasts
 * 0 for Mondays. Plain enough to explain in a sentence, and it follows the
 * weekly rhythm a shop's sales actually have. Orders are forecast only for
 * a branch whose sales have receipt numbers; without them they stay blank.
 */
export function forecastBranch(rows: DailyRow[], days: number): Array<{ date: string; weekday: number; revenue: number; orders: number | null; trend: number }> {
  if (rows.length === 0) return [];
  const countsOrders = rows.some((r) => r.orders != null);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const last = Math.max(...rows.map((r) => dayMs(r.date)));
  const first = Math.min(...rows.map((r) => dayMs(r.date)));
  if ((last - first) / DAY + 1 < RETAIL_RULES.forecastMinHistoryDays) return [];

  const window = (fromBack: number, len: number) =>
    Array.from({ length: len }, (_, i) => isoDay(last - (fromBack + i) * DAY));
  const sumRevenue = (dates: string[]) => dates.reduce((s, d) => s + (byDate.get(d)?.revenue ?? 0), 0);
  const recent = window(0, 28);
  const prior = window(28, 28);
  const priorCovered = prior.some((d) => dayMs(d) >= first) && (last - first) / DAY + 1 >= 56;
  const rawTrend = priorCovered && sumRevenue(prior) > 0 ? sumRevenue(recent) / sumRevenue(prior) : 1;
  const trend = Math.min(1.25, Math.max(0.8, rawTrend));

  const byWeekday = new Map<number, { revenue: number[]; orders: number[] }>();
  for (const d of recent) {
    if (dayMs(d) < first) continue;
    const w = new Date(dayMs(d)).getUTCDay();
    const slot = byWeekday.get(w) ?? { revenue: [], orders: [] };
    slot.revenue.push(byDate.get(d)?.revenue ?? 0);
    slot.orders.push(byDate.get(d)?.orders ?? 0);
    byWeekday.set(w, slot);
  }
  const typical = (xs: number[]) => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  };

  return Array.from({ length: days }, (_, i) => {
    const ms = last + (i + 1) * DAY;
    const w = new Date(ms).getUTCDay();
    const slot = byWeekday.get(w);
    return {
      date: isoDay(ms),
      weekday: w,
      revenue: Math.round(typical(slot?.revenue ?? []) * trend * 100) / 100,
      orders: countsOrders ? Math.round(typical(slot?.orders ?? []) * trend * 10) / 10 : null,
      trend: Math.round(trend * 1000) / 1000,
    };
  });
}

// ---------------------------------------------------------------------------
// basket_pairs — items bought on the same receipt
// ---------------------------------------------------------------------------

const BASKET_PAIRS: TableDef = {
  description: `Items bought on the same receipt over the LAST ${RETAIL_RULES.basketDays} DAYS only, with each item's category (category × category for which aisles shoppers pair): receipts together, support, confidence and lift (above 1 = bought together more than chance).`,
  name: RETAIL_TABLES.basketPairs,
  types: {
    label: "text", item_a: "text", product_a: "text", category_a: "text", item_b: "text", product_b: "text", category_b: "text",
    receipts_together: "number", support: "number", confidence_a_to_b: "number", confidence_b_to_a: "number", lift: "number",
  },
};

// A receipt is a (branch, receipt number) — numbering restarts per branch in
// most POS exports. Only receipts from the last basketDays; a receipt with
// more than basketMaxItems different items (a wholesale order, a stock
// transfer keyed as a sale) says nothing about what shoppers pair.
const BASKET_SETUP = [
  `DROP TABLE IF EXISTS temp.__basket_lines`,
  `DROP TABLE IF EXISTS temp.__basket_multi`,
  `CREATE TEMP TABLE __basket_lines AS
     SELECT DISTINCT s.branch || char(31) || s.receipt_id AS rk, ${itemKey("s")} AS item
     FROM sales_lines s, (SELECT MAX(sale_date) AS d FROM sales_lines) ctx
     WHERE s.receipt_id IS NOT NULL AND s.receipt_id <> '' AND ${itemKey("s")} IS NOT NULL
       AND s.sale_date > date(ctx.d, '-${RETAIL_RULES.basketDays} day')`,
  `CREATE INDEX temp.__basket_lines_by_rk ON __basket_lines (rk, item)`,
  `CREATE TEMP TABLE __basket_multi AS
     SELECT l.rk, l.item FROM __basket_lines l
     JOIN (SELECT rk FROM __basket_lines GROUP BY rk HAVING COUNT(*) BETWEEN 2 AND ${RETAIL_RULES.basketMaxItems}) m ON m.rk = l.rk`,
  `CREATE INDEX temp.__basket_multi_by_rk ON __basket_multi (rk, item)`,
];
const BASKET_TEARDOWN = [`DROP TABLE IF EXISTS temp.__basket_multi`, `DROP TABLE IF EXISTS temp.__basket_lines`];

/**
 * support    = receipts with both ÷ all receipts
 * confidence = receipts with both ÷ receipts with the first item
 * lift       = how much more often they're bought together than chance
 *              would put them together (1 = no link; 2 = twice as often)
 * Pairs seen on fewer than basketMinReceipts receipts are left out — too
 * few to mean anything.
 */
const BASKET_PAIRS_SQL = `
  WITH total AS (SELECT COUNT(DISTINCT rk) AS n FROM temp.__basket_lines),
  item_n AS (SELECT item, COUNT(*) AS n FROM temp.__basket_lines GROUP BY item),
  names AS (SELECT ${itemKey("s")} AS item, MAX(s.product) AS product, MAX(s.category) AS category FROM sales_lines s GROUP BY 1),
  pairs AS (
    SELECT x.item AS a, y.item AS b, COUNT(*) AS together
    FROM temp.__basket_multi x JOIN temp.__basket_multi y ON y.rk = x.rk AND y.item > x.item
    GROUP BY x.item, y.item
    HAVING COUNT(*) >= ${RETAIL_RULES.basketMinReceipts}
  )
  SELECT COALESCE(na.product, p.a) || ' + ' || COALESCE(nb.product, p.b) AS label,
         p.a AS item_a, na.product AS product_a, na.category AS category_a, p.b AS item_b, nb.product AS product_b, nb.category AS category_b,
         p.together AS receipts_together,
         ROUND(p.together * 1.0 / total.n, 4) AS support,
         ROUND(p.together * 1.0 / ia.n, 3) AS confidence_a_to_b,
         ROUND(p.together * 1.0 / ib.n, 3) AS confidence_b_to_a,
         ROUND(p.together * 1.0 * total.n / (ia.n * ib.n), 2) AS lift
  FROM pairs p CROSS JOIN total
  JOIN item_n ia ON ia.item = p.a JOIN item_n ib ON ib.item = p.b
  LEFT JOIN names na ON na.item = p.a LEFT JOIN names nb ON nb.item = p.b
  ORDER BY p.together DESC, lift DESC
  LIMIT ${RETAIL_RULES.basketMaxPairs}`;

// ---------------------------------------------------------------------------
// item_ranking — how each item sells across the branches (last basketDays)
// ---------------------------------------------------------------------------

const ITEM_RANKING: TableDef = {
  description: `Each item's sales across the branches over the LAST ${RETAIL_RULES.basketDays} DAYS only — revenue, margin, branches selling and rank. Not the same period as sales_daily or sales_lines.`,
  name: RETAIL_TABLES.itemRanking,
  types: {
    label: "text", item: "text", product: "text", category: "text", branches_selling: "number", branch_share_pct: "number",
    revenue: "number", revenue_per_branch: "number", qty_per_branch_day: "number", margin_pct: "number", rank: "number",
  },
};

/**
 * The starting range for a new branch is the items that sell well in most
 * existing branches — ranked by revenue per branch that sells them, with
 * how many branches do, so "sells everywhere" and "one branch's hit" read
 * apart.
 */
const ITEM_RANKING_SQL = `
  WITH ctx AS (SELECT MAX(sale_date) AS d FROM sales_lines),
  recent AS (
    SELECT s.branch, ${itemKey("s")} AS item, MAX(s.product) AS product, MAX(s.category) AS category,
           SUM(${num("s.net_amount")}) AS revenue, SUM(${num("s.qty")}) AS qty, SUM(${num("s.cost")}) AS cost,
           SUM(s.cost IS NOT NULL AND s.cost <> '') AS costed, COUNT(*) AS lines
    FROM sales_lines s CROSS JOIN ctx
    WHERE s.sale_date > date(ctx.d, '-${RETAIL_RULES.basketDays} day') AND ${itemKey("s")} IS NOT NULL
    GROUP BY s.branch, ${itemKey("s")}
  ),
  days AS (
    SELECT branch, julianday(MAX(sale_date)) - julianday(MIN(sale_date)) + 1 AS n
    FROM sales_lines, ctx WHERE sale_date > date(ctx.d, '-${RETAIL_RULES.basketDays} day') GROUP BY branch
  ),
  nb AS (SELECT COUNT(DISTINCT branch) AS n FROM recent),
  per_item AS (
    SELECT r.item, MAX(r.product) AS product, MAX(r.category) AS category,
           COUNT(*) AS branches_selling, SUM(r.revenue) AS revenue, SUM(r.qty / days.n) AS qty_per_day,
           CASE WHEN SUM(r.costed) = SUM(r.lines) THEN (SUM(r.revenue) - SUM(r.cost)) * 100.0 / NULLIF(SUM(r.revenue), 0) END AS margin_pct
    FROM recent r JOIN days ON days.branch = r.branch
    GROUP BY r.item
  )
  SELECT COALESCE(product, item) AS label, item, product, category, branches_selling,
         ROUND(branches_selling * 100.0 / nb.n, 0) AS branch_share_pct,
         ROUND(revenue, 2) AS revenue,
         ROUND(revenue / branches_selling, 2) AS revenue_per_branch,
         ROUND(qty_per_day / branches_selling, 2) AS qty_per_branch_day,
         ROUND(margin_pct, 1) AS margin_pct,
         ROW_NUMBER() OVER (ORDER BY revenue / branches_selling DESC) AS rank
  FROM per_item CROSS JOIN nb
  ORDER BY rank
  LIMIT ${RETAIL_RULES.itemRankingMax}`;

// ---------------------------------------------------------------------------
// promo_performance — each promotion against the weeks before it
// ---------------------------------------------------------------------------

const PROMO_PERFORMANCE: TableDef = {
  description: `Each promotion's sales during it against the ${RETAIL_RULES.promoBaselineDays} days before it started (uplift %).`,
  name: RETAIL_TABLES.promoPerformance,
  types: {
    promo_code: "text", start_date: "date", end_date: "date", days: "number", branches: "number", items: "number",
    lines: "number", qty: "number", revenue: "number", discount: "number", margin: "number",
    daily_revenue_during: "number", daily_revenue_before: "number", baseline_days: "number", uplift_pct: "number",
  },
};

/**
 * A promotion's window is the first to the last day its code appears. The
 * baseline is the same items in the same branches over the promoBaselineDays
 * before it (fewer if the data starts later; none if it starts with the
 * promotion — then there's no uplift figure rather than an invented one).
 * The uplift compares daily revenue of those items, promo and non-promo
 * sales alike, during the window against the baseline. Margin is given only
 * when every promo line has a cost.
 */
const PROMO_PERFORMANCE_SQL = `
  WITH first_day AS (SELECT MIN(sale_date) AS d FROM sales_lines),
  promo AS (
    SELECT TRIM(s.promo_code) AS promo_code, s.branch, ${itemKey("s")} AS item, s.sale_date,
           ${num("s.net_amount")} AS net, ${num("s.discount")} AS disc, ${num("s.cost")} AS cost, ${num("s.qty")} AS qty
    FROM sales_lines s
    WHERE s.promo_code IS NOT NULL AND TRIM(s.promo_code) <> '' AND s.sale_date IS NOT NULL
  ),
  win AS (
    SELECT promo_code, MIN(sale_date) AS start_date, MAX(sale_date) AS end_date,
           julianday(MAX(sale_date)) - julianday(MIN(sale_date)) + 1 AS days,
           COUNT(DISTINCT branch) AS branches, COUNT(DISTINCT item) AS items, COUNT(*) AS lines,
           SUM(qty) AS qty, SUM(net) AS revenue, SUM(COALESCE(disc, 0)) AS discount,
           CASE WHEN COUNT(cost) = COUNT(*) THEN SUM(net) - SUM(cost) END AS margin
    FROM promo GROUP BY promo_code
  ),
  scope AS (SELECT DISTINCT promo_code, branch, item FROM promo),
  base AS (
    SELECT w.promo_code,
           MIN(${RETAIL_RULES.promoBaselineDays}, CAST(julianday(w.start_date) - julianday(fd.d) AS INTEGER)) AS baseline_days
    FROM win w CROSS JOIN first_day fd
  ),
  during AS (
    SELECT sc.promo_code, SUM(${num("l.net_amount")}) AS rev
    FROM scope sc JOIN win w ON w.promo_code = sc.promo_code
    JOIN sales_lines l ON l.branch = sc.branch AND l.sale_date BETWEEN w.start_date AND w.end_date AND ${itemKey("l")} = sc.item
    GROUP BY sc.promo_code
  ),
  before AS (
    SELECT sc.promo_code, SUM(${num("l.net_amount")}) AS rev
    FROM scope sc JOIN win w ON w.promo_code = sc.promo_code JOIN base b ON b.promo_code = sc.promo_code
    JOIN sales_lines l ON l.branch = sc.branch AND l.sale_date >= date(w.start_date, '-' || b.baseline_days || ' day')
      AND l.sale_date < w.start_date AND ${itemKey("l")} = sc.item
    WHERE b.baseline_days > 0
    GROUP BY sc.promo_code
  )
  SELECT w.promo_code, w.start_date, w.end_date, w.days, w.branches, w.items, w.lines, w.qty,
         ROUND(w.revenue, 2) AS revenue, ROUND(w.discount, 2) AS discount, ROUND(w.margin, 2) AS margin,
         ROUND(during.rev / w.days, 2) AS daily_revenue_during,
         CASE WHEN b.baseline_days > 0 THEN ROUND(COALESCE(before.rev, 0) / b.baseline_days, 2) END AS daily_revenue_before,
         CASE WHEN b.baseline_days > 0 THEN b.baseline_days END AS baseline_days,
         CASE WHEN b.baseline_days > 0 AND before.rev > 0
              THEN ROUND(((during.rev / w.days) / (before.rev / b.baseline_days) - 1) * 100, 1) END AS uplift_pct
  FROM win w JOIN base b ON b.promo_code = w.promo_code
  LEFT JOIN during ON during.promo_code = w.promo_code LEFT JOIN before ON before.promo_code = w.promo_code
  ORDER BY w.start_date DESC, w.promo_code`;

// ---------------------------------------------------------------------------
// sales_hourly — one row per branch per day per hour (sales with a time only)
// ---------------------------------------------------------------------------

const SALES_HOURLY: TableDef = {
  description: `Sales per branch per day per hour, all of the sales history (sales recorded with a time only).`,
  name: RETAIL_TABLES.salesHourly,
  types: { date: "date", weekday: "number", hour: "number", branch: "text", revenue: "number", items: "number", orders: "number" },
};

// sale_time is "HH:MM" (columnMapping.ts hhmm) — the hour is its first two characters.
const HOUR = (alias: string) => `CAST(substr(${alias}.sale_time, 1, 2) AS INTEGER)`;
const HAS_TIME = (alias: string) => `${alias}.sale_time IS NOT NULL AND ${alias}.sale_time <> ''`;

const SALES_HOURLY_SQL = `
  SELECT s.sale_date AS date,
         CAST(strftime('%w', s.sale_date) AS INTEGER) AS weekday,
         ${HOUR("s")} AS hour,
         s.branch,
         ROUND(SUM(${num("s.net_amount")}), 2) AS revenue,
         SUM(${num("s.qty")}) AS items,
         ${ORDERS} AS orders
  FROM sales_lines s
  WHERE s.sale_date IS NOT NULL AND ${HAS_TIME("s")}
  GROUP BY s.sale_date, ${HOUR("s")}, s.branch`;

// ---------------------------------------------------------------------------
// item_sales — each item at each branch: the last demandDays against the
// demandDays before
// ---------------------------------------------------------------------------

const ITEM_SALES: TableDef = {
  description: `Each item at each branch over the LAST ${RETAIL_RULES.demandDays} DAYS, against the ${RETAIL_RULES.demandDays} days before (and the last 7 against the 7 before).`,
  name: RETAIL_TABLES.itemSales,
  types: {
    label: "text", branch: "text", item: "text", product: "text", category: "text",
    qty: "number", revenue: "number", cost: "number", days: "number", qty_per_day: "number",
    qty_prev: "number", revenue_prev: "number", full_compare: "number",
    qty_7: "number", revenue_7: "number", cost_7: "number",
    qty_prev7: "number", revenue_prev7: "number", cost_prev7: "number", full_compare7: "number",
    cost_source: "text",
  },
};

/**
 * days is how many of the recent window the branch was selling (a branch
 * opened ten days ago sells per ten days, not per 28). qty_prev and
 * revenue_prev are given only when the branch's sales cover the whole
 * window before (full_compare = 1) — a half-covered window would read as a
 * jump in demand that never happened. The _7 columns are the same for the
 * last week against the week before (the weekly summary, lib/retail/weekly.ts).
 *
 * Cost, for margins: the sales lines' own cost when every line in the
 * window has one ("sales"), else units × the latest stock count's unit cost
 * ("stock"), else blank — never a cost made up from part of the lines.
 */
function itemSalesSql(hasStock: boolean): string {
  const d = RETAIL_RULES.demandDays;
  const win = (from: number, to = 0) =>
    `s.sale_date > date(ctx.d, '-${from} day')` + (to ? ` AND s.sale_date <= date(ctx.d, '-${to} day')` : "");
  const windows = { r: win(d), p: win(2 * d, d), r7: win(7), p7: win(14, 7) };
  const sum = (w: string, expr: string) => `SUM(CASE WHEN ${w} THEN ${expr} END)`;
  // The window's line cost, only when every line in it has one.
  const lineCost = (w: string) =>
    `CASE WHEN ${sum(w, "1")} = ${sum(w, "(s.cost IS NOT NULL AND s.cost <> '')")} THEN ${sum(w, num("s.cost"))} END`;
  const cost = (sales: string, qty: string) => `ROUND(COALESCE(w.${sales}, COALESCE(w.${qty}, 0) * uc.unit_cost), 2)`;
  const stockCost = hasStock
    ? `snap AS (SELECT branch, MAX(snapshot_date) AS d FROM inventory GROUP BY branch),
  uc AS (
    SELECT i.branch, ${itemKey("i")} AS item, MAX(${num("i.unit_cost")}) AS unit_cost
    FROM inventory i CROSS JOIN snap
    WHERE snap.branch = i.branch AND snap.d = i.snapshot_date AND i.unit_cost IS NOT NULL AND i.unit_cost <> ''
    GROUP BY 1, 2
  ),`
    : `uc AS (SELECT NULL AS branch, NULL AS item, NULL AS unit_cost WHERE 0),`;
  return `
  WITH ctx AS (SELECT MAX(sale_date) AS d FROM sales_lines),
  opened AS (SELECT branch, MIN(sale_date) AS f FROM sales_lines WHERE sale_date IS NOT NULL GROUP BY branch),
  ${stockCost}
  w AS (
    SELECT s.branch, ${itemKey("s")} AS item, MAX(s.product) AS product, MAX(s.category) AS category,
           ${sum(windows.r, num("s.qty"))} AS qty,
           ${sum(windows.r, num("s.net_amount"))} AS revenue,
           ${lineCost(windows.r)} AS sales_cost,
           ${sum(windows.p, num("s.qty"))} AS qty_prev,
           ${sum(windows.p, num("s.net_amount"))} AS revenue_prev,
           ${sum(windows.r7, num("s.qty"))} AS qty_7,
           ${sum(windows.r7, num("s.net_amount"))} AS revenue_7,
           ${lineCost(windows.r7)} AS sales_cost_7,
           ${sum(windows.p7, num("s.qty"))} AS qty_prev7,
           ${sum(windows.p7, num("s.net_amount"))} AS revenue_prev7,
           ${lineCost(windows.p7)} AS sales_cost_prev7
    FROM sales_lines s CROSS JOIN ctx
    WHERE ${win(2 * d)} AND ${itemKey("s")} IS NOT NULL
    GROUP BY s.branch, ${itemKey("s")}
  ),
  b AS (
    SELECT opened.branch,
           MIN(${d}, julianday(ctx.d) - julianday(opened.f) + 1) AS days,
           julianday(opened.f) <= julianday(ctx.d) - ${2 * d - 1} AS full_compare,
           julianday(opened.f) <= julianday(ctx.d) - 13 AS full_compare7
    FROM opened CROSS JOIN ctx
  )
  SELECT COALESCE(w.product, w.item) AS label, w.branch, w.item, w.product, w.category,
         COALESCE(w.qty, 0) AS qty,
         ROUND(COALESCE(w.revenue, 0), 2) AS revenue,
         ${cost("sales_cost", "qty")} AS cost,
         b.days,
         ROUND(COALESCE(w.qty, 0) / b.days, 3) AS qty_per_day,
         CASE WHEN b.full_compare THEN COALESCE(w.qty_prev, 0) END AS qty_prev,
         CASE WHEN b.full_compare THEN ROUND(COALESCE(w.revenue_prev, 0), 2) END AS revenue_prev,
         b.full_compare,
         COALESCE(w.qty_7, 0) AS qty_7,
         ROUND(COALESCE(w.revenue_7, 0), 2) AS revenue_7,
         ${cost("sales_cost_7", "qty_7")} AS cost_7,
         CASE WHEN b.full_compare7 THEN COALESCE(w.qty_prev7, 0) END AS qty_prev7,
         CASE WHEN b.full_compare7 THEN ROUND(COALESCE(w.revenue_prev7, 0), 2) END AS revenue_prev7,
         CASE WHEN b.full_compare7 THEN ${cost("sales_cost_prev7", "qty_prev7")} END AS cost_prev7,
         b.full_compare7,
         CASE WHEN w.sales_cost IS NOT NULL THEN 'sales' WHEN uc.unit_cost IS NOT NULL THEN 'stock' END AS cost_source
  FROM w JOIN b ON b.branch = w.branch
  LEFT JOIN uc ON uc.branch = w.branch AND uc.item = w.item`;
}

// ---------------------------------------------------------------------------
// item_by_time — when the best sellers sell: the top heatmapItems items of
// the last demandDays, by branch, weekday and hour
// ---------------------------------------------------------------------------

const ITEM_BY_TIME: TableDef = {
  description: `When the best sellers sell: the top items' quantity and revenue by weekday and hour over the LAST ${RETAIL_RULES.demandDays} DAYS.`,
  name: RETAIL_TABLES.itemByTime,
  types: {
    branch: "text", item: "text", product: "text", rank: "number",
    weekday: "number", hour: "number", qty: "number", revenue: "number",
  },
};

/** hour is blank for sales with no time — those still count by weekday. */
const ITEM_BY_TIME_SQL = `
  WITH ctx AS (SELECT MAX(sale_date) AS d FROM sales_lines),
  recent AS (
    SELECT s.branch, s.sale_date, s.sale_time, s.product, s.qty, s.net_amount, ${itemKey("s")} AS item
    FROM sales_lines s CROSS JOIN ctx
    WHERE s.sale_date > date(ctx.d, '-${RETAIL_RULES.demandDays} day') AND ${itemKey("s")} IS NOT NULL
  ),
  top AS (
    SELECT item, MAX(product) AS product, ROW_NUMBER() OVER (ORDER BY SUM(${num("net_amount")}) DESC, item) AS rank
    FROM recent GROUP BY item ORDER BY rank LIMIT ${RETAIL_RULES.heatmapItems}
  )
  SELECT r.branch, r.item, COALESCE(top.product, r.item) AS product, top.rank,
         CAST(strftime('%w', r.sale_date) AS INTEGER) AS weekday,
         CASE WHEN ${HAS_TIME("r")} THEN ${HOUR("r")} END AS hour,
         SUM(${num("r.qty")}) AS qty,
         ROUND(SUM(${num("r.net_amount")}), 2) AS revenue
  FROM recent r JOIN top ON top.item = r.item
  GROUP BY r.branch, r.item, 5, 6`;

// ---------------------------------------------------------------------------
// payment_daily — sales by payment method, per branch per day
// ---------------------------------------------------------------------------

const PAYMENT_DAILY: TableDef = {
  description: `Sales by payment method per branch per day, all of the sales history.`,
  name: RETAIL_TABLES.paymentDaily,
  types: { date: "date", branch: "text", method: "text", revenue: "number", orders: "number", lines: "number" },
};

/**
 * Each POS names payment methods its own way ("เงินสด", "Cash", "QR
 * PromptPay", "พร้อมเพย์", "VISA"…). These fold them into one name per
 * method, first match wins; a name that matches none is kept as written.
 */
export const PAYMENT_METHODS: Array<{ code: string; patterns: string[] }> = [
  { code: "cash", patterns: ["cash", "เงินสด"] },
  { code: "voucher", patterns: ["voucher", "gift", "บัตรกำนัล", "บัตรของขวัญ", "คูปอง", "coupon"] },
  { code: "ewallet", patterns: ["wallet", "วอลเล็ท", "วอลเลท", "วอลเล็ต", "truemoney", "true money", "ทรูมันนี่", "rabbit", "line pay", "linepay", "shopeepay", "shopee pay", "grabpay", "alipay", "wechat"] },
  { code: "qr", patterns: ["promptpay", "prompt pay", "พร้อมเพย์", "qr", "คิวอาร์"] },
  { code: "card", patterns: ["card", "บัตร", "visa", "master", "jcb", "amex", "unionpay", "credit", "debit", "เครดิต", "เดบิต", "edc"] },
  { code: "transfer", patterns: ["transfer", "โอน", "bank", "ธนาคาร"] },
];

// LIKE ignores ASCII case; Thai has none.
const PAYMENT_METHOD = `CASE
    WHEN NULLIF(TRIM(payment_method), '') IS NULL THEN NULL
    ${PAYMENT_METHODS.map((m) => `WHEN ${m.patterns.map((p) => `payment_method LIKE '%${p}%'`).join(" OR ")} THEN '${m.code}'`).join("\n    ")}
    ELSE TRIM(payment_method)
  END`;

/** Sales with no payment method given are a row of their own (method blank), so shares add up to all sales. */
const PAYMENT_DAILY_SQL = `
  SELECT sale_date AS date, branch, method,
         ROUND(SUM(${num("net_amount")}), 2) AS revenue,
         ${ORDERS} AS orders,
         COUNT(*) AS lines
  FROM (SELECT sale_date, branch, receipt_id, net_amount, ${PAYMENT_METHOD} AS method FROM sales_lines WHERE sale_date IS NOT NULL)
  GROUP BY sale_date, branch, method`;

/**
 * What the sales data has beyond the basics, from the tables above: times
 * of sale in at least two different hours (a file of dates at midnight
 * doesn't count), a payment method on at least one line, a cost for at
 * least one item that sold (from the sales lines or the stock count), and
 * receipt numbers on at least one day — what orders, the average ticket and
 * items per order are counted from.
 */
export function retailCapabilities(tenantId: string): { hasTime: boolean; hasPayment: boolean; hasCost: boolean; hasReceipts: boolean } {
  const db = openLake(tenantId);
  const hasReceipts = lakeTableExists(tenantId, SALES_DAILY.name)
    && !!db.prepare(`SELECT 1 FROM ${SALES_DAILY.name} WHERE orders IS NOT NULL LIMIT 1`).get();
  const hasTime = lakeTableExists(tenantId, SALES_HOURLY.name)
    && ((db.prepare(`SELECT COUNT(DISTINCT hour) AS n FROM ${SALES_HOURLY.name}`).get() as { n: number }).n >= 2);
  const hasPayment = lakeTableExists(tenantId, PAYMENT_DAILY.name)
    && !!db.prepare(`SELECT 1 FROM ${PAYMENT_DAILY.name} WHERE method IS NOT NULL LIMIT 1`).get();
  let hasCost = false;
  const itemCols = lakeTableExists(tenantId, ITEM_SALES.name)
    ? new Set((db.prepare(`PRAGMA table_info("${ITEM_SALES.name}")`).all() as Array<{ name: string }>).map((c) => c.name))
    : null;
  if (itemCols?.has("cost")) {
    hasCost = !!db.prepare(`SELECT 1 FROM ${ITEM_SALES.name} WHERE cost IS NOT NULL AND qty > 0 LIMIT 1`).get();
  } else {
    // item_sales from before it had costs (until the next refresh rebuilds it): ask the sources.
    const any = (table: string, col: string) => lakeTableExists(tenantId, table)
      && !!db.prepare(`SELECT 1 FROM "${table}" WHERE "${col}" IS NOT NULL AND "${col}" <> '' LIMIT 1`).get();
    try { hasCost = any("sales_lines", "cost") || any("inventory", "unit_cost"); } catch { /* a source without the column */ }
  }
  return { hasTime, hasPayment, hasCost, hasReceipts };
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export type RetailRefresh = {
  tables: Array<{ name: string; rowCount: number }>;
  /** Figures that couldn't be built this time; the rest still were. */
  errors?: Array<{ name: string; error: string }>;
};

/**
 * Rebuild every retail table the workspace's data allows: sales figures
 * need sales_lines, stock figures need inventory (and use sales_lines too
 * when there is some). Tables whose source is missing are left alone.
 */
export async function refreshRetailMetrics(user: CurfSessionUser, req?: NextRequest): Promise<RetailRefresh> {
  const tenantId = user.tenantId;
  const hasSales = lakeTableExists(tenantId, "sales_lines");
  const hasStock = lakeTableExists(tenantId, "inventory");
  // A table imported before a dataset column existed reads it as not given.
  if (hasSales) ensureTableColumns(tenantId, "sales_lines", standardColumns(STANDARD_DATASETS.sales_lines));
  if (hasStock) ensureTableColumns(tenantId, "inventory", standardColumns(STANDARD_DATASETS.inventory));
  const sourceConfig = { provenance: PROVENANCE };
  const fromSelect = (def: TableDef, selectSql: string, extra: { setup?: string[]; teardown?: string[] } = {}) =>
    async () => (await replaceTableFromSelect({ tenantId, tableName: def.name, selectSql, sourceConfig, ...extra })).rowCount;

  // Each figure is built on its own: one that fails (an odd value in a
  // column it reads) is reported, and the others still update.
  const steps: Array<{ def: TableDef; build: () => number | Promise<number> }> = [];
  if (hasSales) {
    steps.push({ def: SALES_DAILY, build: fromSelect(SALES_DAILY, SALES_DAILY_SQL) });
    steps.push({ def: SALES_FORECAST, build: () => buildForecast(tenantId, sourceConfig) });
  }
  if (hasStock) steps.push({ def: STOCK_STATUS, build: fromSelect(STOCK_STATUS, stockStatusSql(hasSales)) });
  if (hasSales) {
    steps.push({ def: ITEM_RANKING, build: fromSelect(ITEM_RANKING, ITEM_RANKING_SQL) });
    steps.push({ def: BASKET_PAIRS, build: fromSelect(BASKET_PAIRS, BASKET_PAIRS_SQL, { setup: BASKET_SETUP, teardown: BASKET_TEARDOWN }) });
    steps.push({ def: PROMO_PERFORMANCE, build: fromSelect(PROMO_PERFORMANCE, PROMO_PERFORMANCE_SQL) });
    steps.push({ def: SALES_HOURLY, build: fromSelect(SALES_HOURLY, SALES_HOURLY_SQL) });
    steps.push({ def: ITEM_SALES, build: fromSelect(ITEM_SALES, itemSalesSql(hasStock)) });
    steps.push({ def: ITEM_BY_TIME, build: fromSelect(ITEM_BY_TIME, ITEM_BY_TIME_SQL) });
    steps.push({ def: PAYMENT_DAILY, build: fromSelect(PAYMENT_DAILY, PAYMENT_DAILY_SQL) });
  }

  const done: RetailRefresh["tables"] = [];
  const errors: NonNullable<RetailRefresh["errors"]> = [];
  for (const step of steps) {
    try {
      const started = Date.now();
      const rowCount = await step.build();
      console.info(`[retail] ${tenantId} ${step.def.name}: ${rowCount} rows in ${Date.now() - started} ms`);
      await recordDerivedTable(user, step.def, rowCount, req);
      done.push({ name: step.def.name, rowCount });
    } catch (e: any) {
      errors.push({ name: step.def.name, error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  if (done.length > 0) setImmediate(() => { void bustLakeCacheForTenant(tenantId); });
  return errors.length > 0 ? { tables: done, errors } : { tables: done };
}

/** Next forecastDays per branch, from sales_daily (built just before). */
async function buildForecast(tenantId: string, sourceConfig: Record<string, unknown>): Promise<number> {
  const daily = openLake(tenantId)
    .prepare(`SELECT date, branch, revenue, orders FROM ${SALES_DAILY.name}`)
    .all() as DailyRow[];
  const byBranch = new Map<string, DailyRow[]>();
  for (const row of daily) {
    const list = byBranch.get(row.branch);
    if (list) list.push(row); else byBranch.set(row.branch, [row]);
  }
  const rows = [...byBranch.entries()].flatMap(([branch, rs]) =>
    forecastBranch(rs, RETAIL_RULES.forecastDays).map((f) => ({
      date: f.date, weekday: f.weekday, branch, forecast_revenue: f.revenue, forecast_orders: f.orders, trend: f.trend,
    })),
  );
  // No branch with enough history yet: still the table, with its columns
  // and no rows, so reports built on it show "nothing yet", not an error.
  if (rows.length === 0) {
    return (await replaceTableFromSelect({
      tenantId,
      tableName: SALES_FORECAST.name,
      selectSql: `SELECT '' AS date, 0 AS weekday, '' AS branch, 0.0 AS forecast_revenue, 0.0 AS forecast_orders, 0.0 AS trend WHERE 0`,
      sourceConfig,
    })).rowCount;
  }
  const fc = await createOrReplaceTable({
    tenantId,
    tableName: SALES_FORECAST.name,
    rows,
    sourceKind: "manual",
    sourceConfig,
    columnTypeOverrides: SALES_FORECAST.types,
    forceTypedColumns: true,
  });
  return fc.rowCount;
}

/** The catalog row for a derived table: created once, then kept current. */
async function recordDerivedTable(user: CurfSessionUser, def: TableDef, rowCount: number, req?: NextRequest) {
  const columns: LakeColumn[] = Object.entries(def.types).map(([name, type]) => ({ name, type, ...(def.valueLabels?.[name] ? { valueLabels: def.valueLabels[name] } : {}), ...(def.formats?.[name] ? { format: def.formats[name] } : {}) }));
  const existing = await prisma.lakeTable.findFirst({ where: { ...tenantWhere(user), name: def.name }, select: { id: true, description: true } });
  if (!existing) {
    await registerCreatedTable({
      user, req, name: def.name, sourceKind: "manual",
      sourceConfig: { provenance: PROVENANCE }, columns, rowCount, description: def.description,
    });
    return;
  }
  await prisma.lakeTable.updateMany({
    where: { ...tenantWhere(user), id: existing.id },
    data: { rowCount, sizeBytes: lakeFileSize(user.tenantId), schemaJson: JSON.stringify(columns), // A description someone wrote in the catalog stays theirs.
      ...(def.description && !existing.description ? { description: def.description } : {}) },
  });
}
