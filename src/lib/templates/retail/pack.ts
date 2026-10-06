/**
 * The retail pack — reports and watchers for a shop's OWN sales and stock,
 * read from the figures lib/lake/retailMetrics.ts works out of the standard
 * tables (sales_daily, stock_status, sales_forecast).
 *
 * Unlike the sample-data workspace templates it creates no tables and no
 * rows: every number on these reports is the workspace's own, and a report
 * whose source isn't there yet (no sales imported, say) simply isn't
 * created. Applied through applyWorkspaceTemplate (quota checks, skip what
 * already exists) by POST /api/retail/setup.
 *
 * Written in the reader's language at setup time, with every heading,
 * label and legend also in the other languages as the report's translations
 * (withTranslations, lib/reporting/localize.ts) — so a reader who switches
 * language reads it in theirs. Its queries stay in the setup language.
 */
import type { WorkspaceTemplate } from "../workspaces/b2b-saas";
import type { Locale } from "@/lib/i18n/dict";
import { RETAIL_RULES, RETAIL_STATUS_LABELS, sqlCeil } from "@/lib/lake/retailMetrics";
import { withTranslations } from "@/lib/reporting/localize";

/** Report names, stable across languages — found again by these (branch options, re-runs). */
export const RETAIL_REPORTS = {
  overview: "Retail · Branch overview",
  insights: "Retail · Sales insights",
  stock: "Retail · Stock & reorder",
  plan: "Retail · Sales plan",
  basket: "Retail · Basket & promotions",
  menu: "Retail · Menu profitability",
} as const;
export const RETAIL_REPORT_NAMES: string[] = Object.values(RETAIL_REPORTS);

const ALL = "ALL";
const BR = `(:branch = '${ALL}' OR branch = :branch)`;

type Strings = {
  overview: string; overviewSub: string; overviewSubItems: string; stock: string; stockSub: string; plan: string; planSub: string;
  branch: string; allBranches: string; period: string; days7: string; days30: string; days90: string; growth: string;
  revenue: string; orders: string; avgTicket: string; lastDay: string; trend: string; forecast: string;
  ranking: string; weekday: string; weekdays: string[]; growthPct: string; items: string;
  toOrder: string; outItems: string; slowItems: string; stockValue: string; slowValue: string;
  reorderList: string; slowList: string; byAge: string; byStatus: string;
  product: string; onHand: string; perDay: string; cover: string; runout: string; orderQty: string; status: string;
  lastSale: string; daysNoSale: string; age: string; noSales: string;
  statuses: Record<string, string>;
  targets: string; forecast7: string; target7: string; last7: string; next28: string; orderPlan: string;
  methodForecast: string; methodOrders: string; methodBench: string; methodUpside: string;
  tomorrow: string; orderBy: string; planQty: string; perDayTarget: string;
  bench: string; salesPerDay: string; salesIndex: string; ticketIndex: string; ordersPerDay: string; upside: string; benchChange: string;
  lowStockWatcher: string; slowWatcher: string;
  basket: string; basketSub: string; pairs: string; bundles: string; pair: string; together: string; aToB: string; bToA: string; lift: string;
  promos: string; promo: string; start: string; end: string; discount: string; margin: string; uplift: string;
  starter: string; category: string; branchShare: string; perBranch: string; qtyPerDay: string; basketMethod: string;
  discountPct: string; itemsPerOrder: string;
  payments: string; payTable: string; payMethod: string; payNames: Record<string, string>; payNone: string;
  insights: string; insightsSub: string; heatTime: string; heatItem: string; heatItemWeekday: string;
  avgPerDay: string; unitsPerDay: string; bestSellers: string; topUnits: string; rising: string;
  qty: string; qtyPrev: string; share: string; change: string; insightsMethod: string;
  /** What an empty list means — good news, not missing data. */
  risingNone: string; ordersNone: string; reorderNone: string;
  /** And what an empty list is waiting for, where that's the data and not good news. */
  forecastNone: string; pairsNone: string; promosNone: string;
  menu: string; menuSub: string; menuGroups: Record<MenuGroup, string>; menuAdvice: Record<MenuGroup, string>; menuAction: Record<MenuGroup, string>;
  group: string; avgPrice: string; unitCost: string; unitMargin: string; marginPct: string; marginTotal: string;
  unitsShare: string; advice: string; menuMap: string; menuList: string; noCost: string; noCostNone: string; menuMethod: string;
  /** Drill panels (lib/reporting/drill.ts): the rows behind a click. */
  date: string; drillItem: string; drillDays: string; drillPromo: string; drillPay: string;
};

/** Menu-engineering groups: popularity (units) × margin per unit. */
export type MenuGroup = "star" | "plowhorse" | "puzzle" | "dog";

const R = RETAIL_RULES;

const S: Record<Locale, Strings> = {
  en: {
    overview: "Branch overview", overviewSub: "Every branch at once — sales, orders and average ticket against the period before",
    overviewSubItems: "Every branch at once — sales and units sold against the period before",
    stock: "Stock & reorder", stockSub: "What to order, what's out, and what isn't selling — from the latest stock count of each branch",
    plan: "Sales plan", planSub: "Next week's forecast and target per branch, and what to order to meet it",
    branch: "Branch", allBranches: "All branches", period: "Period", days7: "Last 7 days", days30: "Last 30 days", days90: "Last 90 days",
    growth: "Growth target (%)",
    revenue: "Sales", orders: "Orders", avgTicket: "Average ticket", lastDay: "Latest day's sales", trend: "Daily sales and forecast", forecast: "Forecast",
    ranking: "Branches by sales", weekday: "Average sales by weekday", weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    growthPct: "Change vs previous period (%)", items: "Items",
    toOrder: "Items to order", outItems: "Out of stock", slowItems: "Slow movers", stockValue: "Stock value", slowValue: "Value tied up in slow movers",
    reorderList: "To order now", slowList: "Not selling", byAge: "Stock value by days since last sale", byStatus: "Items by status",
    product: "Item", onHand: "On hand", perDay: "Sold per day", cover: "Days of stock", runout: "Runs out", orderQty: "Suggested order", status: "Status",
    lastSale: "Last sale", daysNoSale: "Days without a sale", age: "Days since last sale", noSales: "No sales",
    statuses: RETAIL_STATUS_LABELS.en,
    targets: "Next 7 days: forecast and target", forecast7: "Forecast, next 7 days", target7: "Target, next 7 days", last7: "Last 7 days",
    next28: "Sales forecast, next 28 days", orderPlan: `Order plan, next ${R.planDays} days`,
    methodForecast: `How these figures are worked out: the forecast is the typical same weekday over the last 4 weeks (the middle two of the four, averaged, so one campaign day or one day closed doesn't move it), scaled by the trend of the last 4 weeks against the 4 before (held within ±25%). A branch gets a forecast once it has ${R.forecastMinHistoryDays} days of sales. The target adds your growth target to the forecast.`,
    methodOrders: ` The order plan is what the next ${R.planDays} days need at the target's pace (the rate sold over the last ${R.velocityDays} days plus the growth target), plus ${R.safetyDays} safety days, less what's on hand — to be ordered by the day stock would fall to the delivery lead time plus the safety days.`,
    methodBench: ` The branch comparison uses the last ${R.demandDays} days: 100 is the average of all branches.`,
    methodUpside: ` The extra sales assume a branch keeps its number of orders while its average ticket rises to the average of all branches.`,
    tomorrow: "Forecast, tomorrow", orderBy: "Order by", planQty: "Order (for the target)", perDayTarget: "Sold per day at target",
    bench: `Each branch against the average of all branches (last ${R.demandDays} days)`,
    salesPerDay: "Sales per day", salesIndex: "Sales index (avg = 100)", ticketIndex: "Ticket index (avg = 100)",
    ordersPerDay: "Orders per day", upside: "Extra sales, 7 days", benchChange: `vs ${R.demandDays} days before (%)`,
    lowStockWatcher: "Retail · Low stock", slowWatcher: "Retail · Slow movers",
    basket: "Basket & promotions", basketSub: "What sells together, how each promotion did against the weeks before it, and a starting range for a new branch",
    pairs: "Bought together", bundles: "Bundle ideas", pair: "Items", together: "Receipts with both",
    aToB: "Buyers of the first who also buy the second (%)", bToA: "Buyers of the second who also buy the first (%)", lift: "Lift",
    promos: "Promotions", promo: "Promotion", start: "From", end: "To", discount: "Discount given", margin: "Margin", uplift: "Daily sales vs before (%)",
    starter: "Starting range for a new branch", category: "Category", branchShare: "Branches selling it (%)", perBranch: "Sales per branch", qtyPerDay: "Sold per day per branch",
    basketMethod: `How these figures are worked out, from the last ${RETAIL_RULES.basketDays} days of sales: a receipt is one receipt number at one branch; receipts with more than ${RETAIL_RULES.basketMaxItems} different items are left out as bulk orders, and a pair must appear on at least ${RETAIL_RULES.basketMinReceipts} receipts. Lift above 1 means the two are bought together more often than chance — 2 means twice as often. A promotion runs from the first to the last day its code appears; its items' daily sales in those days are compared with the same items in the same branches over up to ${RETAIL_RULES.promoBaselineDays} days before it.`,
    discountPct: "Discount, share of sales before discount", itemsPerOrder: "Items per order",
    payments: "How customers pay", payTable: "Sales by payment method", payMethod: "Payment method", payNone: "Not given",
    payNames: { cash: "Cash", qr: "QR / PromptPay", card: "Card", ewallet: "E-wallet", transfer: "Bank transfer", voucher: "Voucher / gift card" },
    insights: "Sales insights", insightsSub: `When sales come in, what sells most, and what's selling more than before — last ${R.demandDays} days`,
    heatTime: "Average sales per day, by weekday and hour", heatItem: "When the best sellers sell — units per day, by hour",
    heatItemWeekday: "When the best sellers sell — units per day, by weekday",
    avgPerDay: "Average sales per day", unitsPerDay: "Units per day", bestSellers: "Best sellers", topUnits: "Most units sold",
    rising: "Demand rising", qty: "Units sold", qtyPrev: `Units, ${R.demandDays} days before`, share: "Share of sales (%)",
    change: `vs ${R.demandDays} days before (%)`,
    risingNone: `No item is selling ${R.risingMinPct}% or more above the ${R.demandDays} days before.`,
    ordersNone: `Nothing needs ordering in the next ${R.planDays} days.`,
    reorderNone: "Nothing needs ordering right now.",
    forecastNone: `No forecast yet — a branch gets one once it has ${R.forecastMinHistoryDays} days of sales.`,
    pairsNone: "No items sold together often enough yet. Pairs are counted from receipt numbers, so sales imported without them can't be matched.",
    promosNone: "No promotions yet. They are read from the promotion code on each sales line, so sales imported without one show none.",
    menu: "Menu profitability", menuSub: `Which items make you money and which only look busy — last ${R.demandDays} days, by margin per unit and units sold`,
    menuGroups: { star: "Star", plowhorse: "Plowhorse", puzzle: "Puzzle", dog: "Dog" },
    menuAdvice: {
      star: "Sells well and earns well per unit — keep it and promote it",
      plowhorse: "Sells well but earns little per unit — raise the price or lower the cost",
      puzzle: "Earns well per unit but few orders — push it harder",
      dog: "Few orders and little per unit — a candidate to drop",
    },
    menuAction: { star: "Keep and promote", plowhorse: "Reprice or cut cost", puzzle: "Push it harder", dog: "Consider dropping" },
    group: "Group", avgPrice: "Average price", unitCost: "Cost per unit", unitMargin: "Margin per unit", marginPct: "Margin (%)",
    marginTotal: "Gross margin", unitsShare: "Share of units (%)", advice: "What to do",
    menuMap: "Every item by group — margin per unit", menuList: "Items by gross margin", noCost: "No cost yet",
    noCostNone: "Every item that sold has a cost.",
    menuMethod: `How items are grouped, from the last ${R.demandDays} days: an item is popular when its share of units sold is at least 70% of an even share (1 ÷ the number of items); it earns well when its margin per unit is at least the average margin per unit of all items. Cost comes from the sales file when every line has one, else from the latest stock count's unit cost; items with neither are listed under "No cost yet" and left out of the groups.`,
    date: "Date", drillItem: `The item by branch, last ${R.demandDays} days`, drillDays: "Sales by day and branch", drillPromo: "What sold in the promotion", drillPay: "Sales by day and branch, this payment method",
    insightsMethod: `How these figures are worked out: from the last ${R.demandDays} days of sales, against the ${R.demandDays} days before. A per-day average divides by the days that had sales. The item heatmap shows the ${R.heatmapItems} items with the most sales. Demand is rising when an item sold at least ${R.risingMinQty} units, and at least ${R.risingMinPct}% more than in the ${R.demandDays} days before; a branch with less than ${2 * R.demandDays} days of sales isn't compared.`,
  },
  th: {
    overview: "ภาพรวมทุกสาขา", overviewSub: "ทุกสาขาในหน้าเดียว — ยอดขาย ออเดอร์ และยอดต่อบิล เทียบกับช่วงก่อนหน้า",
    overviewSubItems: "ทุกสาขาในหน้าเดียว — ยอดขายและจำนวนชิ้นที่ขาย เทียบกับช่วงก่อนหน้า",
    stock: "สต็อกและการสั่งซื้อ", stockSub: "ต้องสั่งอะไร อะไรหมด และอะไรขายไม่ออก — จากข้อมูลสต็อกล่าสุดของแต่ละสาขา",
    plan: "แผนการขาย", planSub: "พยากรณ์และเป้ายอดขายสัปดาห์หน้าของแต่ละสาขา และของที่ต้องสั่งเพื่อให้ถึงเป้า",
    branch: "สาขา", allBranches: "ทุกสาขา", period: "ช่วงเวลา", days7: "7 วันล่าสุด", days30: "30 วันล่าสุด", days90: "90 วันล่าสุด",
    growth: "เป้าเติบโต (%)",
    revenue: "ยอดขาย", orders: "ออเดอร์", avgTicket: "ยอดต่อบิล", lastDay: "ยอดขายวันล่าสุด", trend: "ยอดขายรายวันและพยากรณ์", forecast: "พยากรณ์",
    ranking: "อันดับสาขาตามยอดขาย", weekday: "ยอดขายเฉลี่ยตามวันในสัปดาห์", weekdays: ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."],
    growthPct: "เปลี่ยนจากช่วงก่อน (%)", items: "จำนวนสินค้า",
    toOrder: "สินค้าที่ควรสั่ง", outItems: "สินค้าหมด", slowItems: "สินค้าขายไม่ออก", stockValue: "มูลค่าสต็อก", slowValue: "มูลค่าสต็อกที่ขายไม่ออก",
    reorderList: "ต้องสั่งตอนนี้", slowList: "ขายไม่ออก", byAge: "มูลค่าสต็อกตามจำนวนวันที่ไม่มีการขาย", byStatus: "จำนวนสินค้าตามสถานะ",
    product: "สินค้า", onHand: "คงเหลือ", perDay: "ขายต่อวัน", cover: "สต็อกพอ (วัน)", runout: "จะหมดวันที่", orderQty: "ควรสั่ง", status: "สถานะ",
    lastSale: "ขายล่าสุด", daysNoSale: "ไม่มีการขาย (วัน)", age: "จำนวนวันที่ไม่มีการขาย", noSales: "ไม่เคยขาย",
    statuses: RETAIL_STATUS_LABELS.th,
    targets: "7 วันข้างหน้า: พยากรณ์และเป้า", forecast7: "พยากรณ์ 7 วันข้างหน้า", target7: "เป้า 7 วันข้างหน้า", last7: "7 วันที่ผ่านมา",
    next28: "พยากรณ์ยอดขาย 28 วันข้างหน้า", orderPlan: `แผนการสั่งซื้อ ${R.planDays} วันข้างหน้า`,
    methodForecast: `วิธีคำนวณ: พยากรณ์ใช้ค่ากลางของวันเดียวกันในสัปดาห์ย้อนหลัง 4 สัปดาห์ (เฉลี่ยสองค่ากลางจากสี่ค่า เพื่อไม่ให้วันแคมเปญหรือวันที่ปิดร้านวันเดียวดึงพยากรณ์) ปรับด้วยแนวโน้ม 4 สัปดาห์ล่าสุดเทียบกับ 4 สัปดาห์ก่อนหน้า (ไม่เกิน ±25%) สาขาจะมีพยากรณ์เมื่อมีข้อมูลยอดขายครบ ${R.forecastMinHistoryDays} วัน เป้าคือพยากรณ์บวกเป้าเติบโตที่คุณตั้ง`,
    methodOrders: ` แผนการสั่งซื้อคือจำนวนที่ต้องใช้ใน ${R.planDays} วันข้างหน้าตามอัตราขายของเป้า (อัตราขายเฉลี่ย ${R.velocityDays} วันล่าสุดบวกเป้าเติบโต) บวกสำรองอีก ${R.safetyDays} วัน หักของคงเหลือ และควรสั่งภายในวันที่สต็อกจะลดลงจนเหลือพอแค่ช่วงเวลารอของบวกวันสำรอง`,
    methodBench: ` การเทียบสาขาใช้ข้อมูล ${R.demandDays} วันล่าสุด 100 คือค่าเฉลี่ยของทุกสาขา`,
    methodUpside: ` ยอดที่เพิ่มได้คิดจากจำนวนออเดอร์เท่าเดิม แต่ยอดต่อบิลเพิ่มขึ้นจนเท่าค่าเฉลี่ยของทุกสาขา`,
    tomorrow: "พยากรณ์ยอดขายพรุ่งนี้", orderBy: "สั่งภายในวันที่", planQty: "ควรสั่ง (ตามเป้า)", perDayTarget: "ขายต่อวันตามเป้า",
    bench: `เทียบแต่ละสาขากับค่าเฉลี่ยทุกสาขา (${R.demandDays} วันล่าสุด)`,
    salesPerDay: "ยอดขายต่อวัน", salesIndex: "ดัชนียอดขาย (เฉลี่ย = 100)", ticketIndex: "ดัชนียอดต่อบิล (เฉลี่ย = 100)",
    ordersPerDay: "ออเดอร์ต่อวัน", upside: "ยอดที่เพิ่มได้ใน 7 วัน", benchChange: `เทียบ ${R.demandDays} วันก่อน (%)`,
    lowStockWatcher: "ร้านค้า · สินค้าใกล้หมด", slowWatcher: "ร้านค้า · สินค้าขายไม่ออก",
    basket: "ตะกร้าสินค้าและโปรโมชัน", basketSub: "สินค้าที่ขายคู่กัน ผลของแต่ละโปรโมชันเทียบกับช่วงก่อนหน้า และรายการสินค้าตั้งต้นสำหรับสาขาใหม่",
    pairs: "สินค้าที่ซื้อคู่กัน", bundles: "ไอเดียจัดชุดสินค้า", pair: "สินค้า", together: "บิลที่มีทั้งคู่",
    aToB: "คนซื้อชิ้นแรกที่ซื้อชิ้นที่สองด้วย (%)", bToA: "คนซื้อชิ้นที่สองที่ซื้อชิ้นแรกด้วย (%)", lift: "ค่าความสัมพันธ์ (Lift)",
    promos: "โปรโมชัน", promo: "โปรโมชัน", start: "เริ่ม", end: "สิ้นสุด", discount: "ส่วนลดที่ให้", margin: "กำไรขั้นต้น", uplift: "ยอดขายต่อวันเทียบก่อนโปร (%)",
    starter: "รายการสินค้าตั้งต้นสำหรับสาขาใหม่", category: "หมวดหมู่", branchShare: "สาขาที่ขาย (%)", perBranch: "ยอดขายต่อสาขา", qtyPerDay: "ขายต่อวันต่อสาขา",
    basketMethod: `วิธีคำนวณ จากยอดขาย ${RETAIL_RULES.basketDays} วันล่าสุด: หนึ่งบิลคือเลขที่บิลหนึ่งเลขในสาขาหนึ่ง บิลที่มีสินค้าต่างชนิดเกิน ${RETAIL_RULES.basketMaxItems} รายการถือเป็นการขายส่งและไม่นำมาคิด คู่สินค้าต้องปรากฏอย่างน้อย ${RETAIL_RULES.basketMinReceipts} บิล ค่า Lift มากกว่า 1 แปลว่าซื้อคู่กันบ่อยกว่าที่ควรเป็นโดยบังเอิญ (2 คือบ่อยเป็นสองเท่า) ช่วงโปรโมชันนับจากวันแรกถึงวันสุดท้ายที่มีรหัสโปรนั้น แล้วเทียบยอดขายต่อวันของสินค้าในโปรกับสินค้าเดียวกันในสาขาเดียวกันช่วงไม่เกิน ${RETAIL_RULES.promoBaselineDays} วันก่อนเริ่มโปร`,
    discountPct: "ส่วนลดต่อยอดขายก่อนหักส่วนลด", itemsPerOrder: "จำนวนชิ้นต่อบิล",
    payments: "ลูกค้าจ่ายด้วยอะไร", payTable: "ยอดขายตามวิธีชำระเงิน", payMethod: "วิธีชำระเงิน", payNone: "ไม่ระบุ",
    payNames: { cash: "เงินสด", qr: "QR / พร้อมเพย์", card: "บัตร", ewallet: "e-Wallet", transfer: "โอนเงิน", voucher: "บัตรกำนัล / คูปอง" },
    insights: "ข้อมูลเชิงลึกการขาย", insightsSub: `ขายดีช่วงไหน อะไรขายดีที่สุด และอะไรขายดีขึ้นกว่าเดิม — ${R.demandDays} วันล่าสุด`,
    heatTime: "ยอดขายเฉลี่ยต่อวัน แยกตามวันและชั่วโมง", heatItem: "สินค้าขายดีขายช่วงไหน — จำนวนชิ้นเฉลี่ยต่อวัน ตามชั่วโมง",
    heatItemWeekday: "สินค้าขายดีขายวันไหน — จำนวนชิ้นเฉลี่ยต่อวัน ตามวันในสัปดาห์",
    avgPerDay: "ยอดขายเฉลี่ยต่อวัน", unitsPerDay: "ชิ้นต่อวัน", bestSellers: "สินค้าขายดี", topUnits: "ขายได้จำนวนชิ้นมากที่สุด",
    rising: "สินค้าที่ความต้องการเพิ่มขึ้น", qty: "จำนวนที่ขาย (ชิ้น)", qtyPrev: `${R.demandDays} วันก่อนหน้า (ชิ้น)`, share: "สัดส่วนยอดขาย (%)",
    change: `เทียบ ${R.demandDays} วันก่อนหน้า (%)`,
    risingNone: `ยังไม่มีสินค้าที่ขายเพิ่มขึ้นตั้งแต่ ${R.risingMinPct}% จาก ${R.demandDays} วันก่อนหน้า`,
    ordersNone: `ยังไม่มีสินค้าที่ต้องสั่งใน ${R.planDays} วันข้างหน้า`,
    reorderNone: "ตอนนี้ยังไม่มีสินค้าที่ต้องสั่ง",
    forecastNone: `ยังไม่มีพยากรณ์ — สาขาจะมีพยากรณ์เมื่อมีข้อมูลยอดขายครบ ${R.forecastMinHistoryDays} วัน`,
    pairsNone: "ยังไม่มีสินค้าที่ขายคู่กันบ่อยพอ รายการนี้นับจากเลขที่บิล ยอดขายที่นำเข้าโดยไม่มีเลขที่บิลจึงจับคู่ไม่ได้",
    promosNone: "ยังไม่มีโปรโมชัน รายการนี้อ่านจากรหัสโปรโมชันในแต่ละบรรทัดยอดขาย ยอดขายที่นำเข้าโดยไม่มีรหัสจึงไม่แสดง",
    menu: "วิเคราะห์เมนูและกำไร", menuSub: `เมนูไหนทำเงินจริง เมนูไหนแค่ขายดีแต่ไม่ได้กำไร — ${R.demandDays} วันล่าสุด จากกำไรต่อชิ้นและจำนวนที่ขาย`,
    menuGroups: { star: "ดาวเด่น", plowhorse: "ตัวถ่วงเงียบๆ", puzzle: "อัญมณีซ่อนเร้น", dog: "ตัวถ่วงน้ำหนัก" },
    menuAdvice: {
      star: "ขายดีและกำไรต่อชิ้นสูง — รักษาไว้และโปรโมต",
      plowhorse: "ขายดีแต่กำไรต่อชิ้นต่ำ — ปรับราคาหรือลดต้นทุน",
      puzzle: "กำไรต่อชิ้นสูงแต่ยอดสั่งน้อย — ดันให้ขายมากขึ้น",
      dog: "ขายน้อยและกำไรต่อชิ้นต่ำ — ตัวเลือกที่ควรตัดออก",
    },
    menuAction: { star: "รักษาไว้และโปรโมต", plowhorse: "ปรับราคาหรือลดต้นทุน", puzzle: "ดันให้ขายมากขึ้น", dog: "พิจารณาตัดออก" },
    group: "กลุ่ม", avgPrice: "ราคาขายเฉลี่ย", unitCost: "ต้นทุนต่อชิ้น", unitMargin: "กำไรต่อชิ้น", marginPct: "มาร์จิ้น (%)",
    marginTotal: "กำไรขั้นต้นรวม", unitsShare: "สัดส่วนจำนวนที่ขาย (%)", advice: "ควรทำอะไร",
    menuMap: "ทุกเมนูแยกตามกลุ่ม — กำไรต่อชิ้น", menuList: "เมนูเรียงตามกำไรขั้นต้น", noCost: "ยังไม่มีต้นทุน",
    noCostNone: "ทุกเมนูที่ขายได้มีต้นทุนครบแล้ว",
    menuMethod: `วิธีแบ่งกลุ่ม จากยอดขาย ${R.demandDays} วันล่าสุด: เมนูที่ขายดีคือเมนูที่มีสัดส่วนจำนวนที่ขายอย่างน้อย 70% ของส่วนแบ่งเฉลี่ย (1 ÷ จำนวนเมนู) เมนูที่ทำกำไรดีคือเมนูที่กำไรต่อชิ้นไม่ต่ำกว่ากำไรต่อชิ้นเฉลี่ยของทุกเมนู ต้นทุนใช้จากไฟล์ขายเมื่อทุกบรรทัดมีต้นทุน ถ้าไม่มีใช้ต้นทุนต่อหน่วยจากการนับสต็อกล่าสุด เมนูที่ไม่มีต้นทุนทั้งสองแบบจะแยกไว้ใน "ยังไม่มีต้นทุน" และไม่ถูกนำมาจัดกลุ่ม`,
    date: "วันที่", drillItem: `สินค้านี้แยกตามสาขา ${R.demandDays} วันล่าสุด`, drillDays: "ยอดขายรายวันแยกตามสาขา", drillPromo: "สินค้าที่ขายในโปรโมชั่น", drillPay: "ยอดขายรายวันแยกตามสาขา ของวิธีชำระเงินนี้",
    insightsMethod: `วิธีคำนวณ: ใช้ยอดขาย ${R.demandDays} วันล่าสุด เทียบกับ ${R.demandDays} วันก่อนหน้านั้น ค่าเฉลี่ยต่อวันหารด้วยจำนวนวันที่มีการขาย Heatmap สินค้าแสดง ${R.heatmapItems} รายการที่มียอดขายสูงสุด สินค้าที่ความต้องการเพิ่มขึ้นต้องขายได้อย่างน้อย ${R.risingMinQty} ชิ้น และมากกว่า ${R.demandDays} วันก่อนหน้าอย่างน้อย ${R.risingMinPct}% สาขาที่มีข้อมูลการขายไม่ถึง ${2 * R.demandDays} วันจะไม่ถูกนำมาเทียบ`,
  },
  zh: {
    overview: "各分店概览", overviewSub: "所有分店一页看——销售额、订单数与客单价，并与上一时段对比",
    overviewSubItems: "所有分店一页看——销售额与销量，并与上一时段对比",
    stock: "库存与补货", stockSub: "该补什么、什么缺货、什么滞销——基于各分店最新的库存数据",
    plan: "销售计划", planSub: "各分店下周的预测与目标，以及为达成目标需要补的货",
    branch: "分店", allBranches: "全部分店", period: "时段", days7: "最近 7 天", days30: "最近 30 天", days90: "最近 90 天",
    growth: "增长目标（%）",
    revenue: "销售额", orders: "订单数", avgTicket: "客单价", lastDay: "最近一天销售额", trend: "每日销售额与预测", forecast: "预测",
    ranking: "分店销售额排名", weekday: "按星期的平均销售额", weekdays: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
    growthPct: "较上一时段变化（%）", items: "商品数",
    toOrder: "需补货商品", outItems: "缺货商品", slowItems: "滞销商品", stockValue: "库存价值", slowValue: "滞销库存价值",
    reorderList: "现在需补货", slowList: "滞销", byAge: "按未售天数的库存价值", byStatus: "按状态的商品数",
    product: "商品", onHand: "结余", perDay: "日均销量", cover: "可售天数", runout: "预计售罄", orderQty: "建议补货", status: "状态",
    lastSale: "最近销售", daysNoSale: "未售天数", age: "距上次销售天数", noSales: "从未售出",
    statuses: RETAIL_STATUS_LABELS.zh,
    targets: "未来 7 天：预测与目标", forecast7: "未来 7 天预测", target7: "未来 7 天目标", last7: "过去 7 天",
    next28: "未来 28 天销售预测", orderPlan: `未来 ${R.planDays} 天补货计划`,
    methodForecast: `计算方式：预测取过去 4 周同一星期几的典型值（四个值中间两个的平均，一次大促或一天停业不会拉动预测），再按最近 4 周与之前 4 周的趋势调整（不超过 ±25%）。分店有满 ${R.forecastMinHistoryDays} 天的销售数据后才会有预测。目标为预测加上您设定的增长目标。`,
    methodOrders: `补货计划为按目标速度（最近 ${R.velocityDays} 天的日均销量加上增长目标）未来 ${R.planDays} 天所需的数量，加上 ${R.safetyDays} 天安全库存，再减去现有库存；应在库存降至仅够交货期加安全天数之前下单。`,
    methodBench: `分店对比基于最近 ${R.demandDays} 天：100 为全部分店的平均值。`,
    methodUpside: `可增加的销售额假设分店订单数不变，而客单价提升至全部分店的平均值。`,
    tomorrow: "明日销售预测", orderBy: "最晚下单日期", planQty: "建议补货（按目标）", perDayTarget: "按目标日均销量",
    bench: `各分店与全部分店平均值对比（最近 ${R.demandDays} 天）`,
    salesPerDay: "日均销售额", salesIndex: "销售指数（平均 = 100）", ticketIndex: "客单价指数（平均 = 100）",
    ordersPerDay: "日均订单数", upside: "7 天可增加销售额", benchChange: `较前 ${R.demandDays} 天（%）`,
    lowStockWatcher: "零售 · 库存不足", slowWatcher: "零售 · 滞销商品",
    basket: "购物篮与促销", basketSub: "哪些商品一起卖、每次促销与之前几周相比的效果，以及新分店的起步商品清单",
    pairs: "一起购买", bundles: "组合建议", pair: "商品", together: "同时购买的小票数",
    aToB: "买第一件的顾客也买第二件（%）", bToA: "买第二件的顾客也买第一件（%）", lift: "提升度",
    promos: "促销", promo: "促销", start: "开始", end: "结束", discount: "折扣金额", margin: "毛利", uplift: "日均销售额较促销前（%）",
    starter: "新分店起步商品清单", category: "类别", branchShare: "在售分店（%）", perBranch: "每店销售额", qtyPerDay: "每店日均销量",
    basketMethod: `计算方式（基于最近 ${RETAIL_RULES.basketDays} 天的销售）：一张小票指某一分店的一个小票号；不同商品超过 ${RETAIL_RULES.basketMaxItems} 种的小票视为批发订单不计入；组合至少需出现在 ${RETAIL_RULES.basketMinReceipts} 张小票上。提升度大于 1 表示两件商品一起购买的频率高于随机——2 即两倍。促销期为其代码首次到最后一次出现的日期；将促销商品在此期间的日均销售额，与同一分店同一商品在促销前最多 ${RETAIL_RULES.promoBaselineDays} 天的日均销售额相比较。`,
    discountPct: "折扣占折前销售额比例", itemsPerOrder: "每单件数",
    payments: "顾客如何付款", payTable: "按付款方式的销售额", payMethod: "付款方式", payNone: "未注明",
    payNames: { cash: "现金", qr: "二维码 / PromptPay", card: "银行卡", ewallet: "电子钱包", transfer: "银行转账", voucher: "礼券 / 优惠券" },
    insights: "销售洞察", insightsSub: `什么时段卖得好、什么卖得最多、什么比以前卖得更好——最近 ${R.demandDays} 天`,
    heatTime: "按星期和小时的日均销售额", heatItem: "畅销商品在什么时段卖出——按小时的日均件数",
    heatItemWeekday: "畅销商品在星期几卖出——按星期的日均件数",
    avgPerDay: "日均销售额", unitsPerDay: "日均件数", bestSellers: "畅销商品", topUnits: "销量（件数）最高",
    rising: "需求上升的商品", qty: "销量（件）", qtyPrev: `前 ${R.demandDays} 天（件）`, share: "销售额占比（%）",
    change: `较前 ${R.demandDays} 天（%）`,
    risingNone: `目前没有比前 ${R.demandDays} 天销量高出 ${R.risingMinPct}% 或以上的商品。`,
    ordersNone: `未来 ${R.planDays} 天没有需要补货的商品。`,
    reorderNone: "目前没有需要补货的商品。",
    forecastNone: `暂无预测——分店有满 ${R.forecastMinHistoryDays} 天的销售数据后才会有预测。`,
    pairsNone: "暂无经常一起购买的商品。配对按小票号统计，没有小票号的销售数据无法配对。",
    promosNone: "暂无促销。促销按销售明细行上的促销代码统计，没有促销代码的销售数据不会显示。",
    menu: "菜单与利润分析", menuSub: `哪些商品真正赚钱、哪些只是卖得多——最近 ${R.demandDays} 天，按单件毛利和销量`,
    menuGroups: { star: "明星", plowhorse: "耕马", puzzle: "谜题", dog: "瘦狗" },
    menuAdvice: {
      star: "卖得好且单件毛利高——保留并推广",
      plowhorse: "卖得好但单件毛利低——提价或降低成本",
      puzzle: "单件毛利高但点单少——加大推广",
      dog: "点单少且单件毛利低——可考虑下架",
    },
    menuAction: { star: "保留并推广", plowhorse: "提价或降本", puzzle: "加大推广", dog: "考虑下架" },
    group: "分组", avgPrice: "平均售价", unitCost: "单位成本", unitMargin: "单件毛利", marginPct: "毛利率（%）",
    marginTotal: "毛利合计", unitsShare: "销量占比（%）", advice: "建议",
    menuMap: "按分组的全部商品——单件毛利", menuList: "按毛利排序的商品", noCost: "尚无成本",
    noCostNone: "所有已售商品都有成本。",
    menuMethod: `分组方式（基于最近 ${R.demandDays} 天）：销量占比至少为平均占比（1 ÷ 商品数）的 70% 即为畅销；单件毛利不低于全部商品的平均单件毛利即为高毛利。成本优先取自销售文件（每一行都有成本时），否则取最近一次盘点的单位成本；两者都没有的商品列在"尚无成本"中，不参与分组。`,
    date: "日期", drillItem: `该商品按分店，最近 ${R.demandDays} 天`, drillDays: "按日期和分店的销售额", drillPromo: "促销期间售出的商品", drillPay: "此付款方式按日期和分店的销售额",
    insightsMethod: `计算方式：基于最近 ${R.demandDays} 天的销售，并与之前 ${R.demandDays} 天比较。日均值按有销售的天数计算。商品热力图显示销售额最高的 ${R.heatmapItems} 个商品。需求上升指销量至少 ${R.risingMinQty} 件，且比之前 ${R.demandDays} 天多出至少 ${R.risingMinPct}%；销售数据不足 ${2 * R.demandDays} 天的分店不参与比较。`,
  },
};

const nameI18n = (key: keyof typeof RETAIL_REPORTS) => ({ en: S.en[key], th: S.th[key], zh: S.zh[key] });

function branchParam(s: Strings, branches: string[]) {
  return {
    name: "branch", label: s.branch, type: "select" as const, required: false, default: ALL,
    options: [{ value: ALL, label: s.allBranches }, ...branches.map((b) => ({ value: b, label: b }))],
  };
}

const sq = (v: string) => `'${v.replace(/'/g, "''")}'`;
/**
 * A chart's series column, named with the reader's label: a chart shows the
 * column name as its legend and tooltip (charts/shared.ts seriesName keeps a
 * written label as it is), so "revenue" would read "Revenue" in a Thai report.
 */
const qi = (label: string) => `"${label.replace(/"/g, '""')}"`;
const caseMap = (expr: string, map: Record<string, string>, fallback = expr) =>
  `CASE ${expr} ${Object.entries(map).map(([k, v]) => `WHEN ${sq(k)} THEN ${sq(v)}`).join(" ")} ELSE ${fallback} END`;
const weekdayName = (s: Strings, expr = "weekday") =>
  `CASE ${expr} ${s.weekdays.map((d, i) => `WHEN ${i} THEN ${sq(d)}`).join(" ")} END`;
/** The last `days` days (a number, or a :parameter) up to the data's own latest date, a.d. */
const lastDays = (days: number | `:${string}`) =>
  typeof days === "number" ? `date > date(a.d, '-${days} day')` : `date > date(a.d, '-' || ${days} || ' day')`;
/**
 * Sales, items and selling days of the days that have receipt numbers —
 * what a figure per order divides. `orders` is blank for a day imported
 * without them (retailMetrics.ts), and all sales over only some days'
 * orders would overstate the ticket.
 */
const REV_R = `SUM(CASE WHEN orders IS NOT NULL THEN revenue END)`;
const ITEMS_R = `SUM(CASE WHEN orders IS NOT NULL THEN items END)`;
const DAYS_R = `COUNT(DISTINCT CASE WHEN orders IS NOT NULL THEN date END)`;
/**
 * Drill-through (lib/reporting/drill.ts): a clicked item opens its sales by
 * branch. The query runs only on the click — :drill_item is the clicked
 * product, and :branch still narrows it like the rest of the report.
 */
const itemDrillQuery = (lake: string) => ({
  id: "q_drill_item", name: "Drill: the item by branch", dataSourceId: lake,
  sql: `SELECT branch, ROUND(qty, 1) AS qty, ROUND(revenue, 2) AS revenue, ROUND(qty_per_day, 2) AS per_day
        FROM item_sales WHERE product = :drill_item AND ${BR} ORDER BY revenue DESC`,
});
/** A drill panel's column: the query's stable key, the reader's heading, how to format it. */
const dcol = (key: string, label: string, type: "string" | "number" | "currency" | "date" = "string") => ({ key, label, type });
const itemDrill = (s: Strings) => ({
  queryId: "q_drill_item", filterParam: "drill_item", title: s.drillItem,
  columns: [dcol("branch", s.branch), dcol("qty", s.qty, "number"), dcol("revenue", s.revenue, "currency"), dcol("per_day", s.perDay, "number")],
});

// ---------------------------------------------------------------------------

const overviewSub = (s: Strings, hasReceipts: boolean) => (hasReceipts ? s.overviewSub : s.overviewSubItems);

function overviewReport(s: Strings, branches: string[], hasPayment: boolean, hasReceipts: boolean) {
  const dayCols = [dcol("date", s.date, "date"), dcol("branch", s.branch), dcol("revenue", s.revenue, "currency"), ...(hasReceipts ? [dcol("orders", s.orders, "number")] : [])];
  const payLabel = caseMap("method", s.payNames, `COALESCE(method, ${sq(s.payNone)})`);
  // The second and third headline numbers: orders and the average ticket
  // when the sales have receipt numbers. Without them (a POS summary of
  // items per day) there are no orders to count, so they are units sold and
  // the average price of one — never the file's lines passed off as orders.
  const per = hasReceipts
    ? { of: REV_R, n: "SUM(orders)", count: "orders", avg: "avg_ticket", countLabel: s.orders, avgLabel: s.avgTicket, countId: "k_ord", avgId: "k_ticket" }
    : { of: "SUM(revenue)", n: "SUM(items)", count: "items", avg: "avg_price", countLabel: s.qty, avgLabel: s.avgPrice, countId: "k_items", avgId: "k_price" };
  return (lake: string) => ({
    version: 1,
    name: S.en.overview,
    nameI18n: nameI18n("overview"),
    description: overviewSub(s, hasReceipts),
    parameters: [
      branchParam(s, branches),
      {
        name: "period", label: s.period, type: "select", required: false, default: "30",
        options: [{ value: "7", label: s.days7 }, { value: "30", label: s.days30 }, { value: "90", label: s.days90 }],
      },
    ],
    dataSources: [
      {
        id: "q_drill_days", name: "Drill: sales by day and branch", dataSourceId: lake,
        sql: `WITH a AS (SELECT MAX(date) AS d FROM sales_daily)
          SELECT date, branch, ROUND(revenue, 2) AS revenue${hasReceipts ? ", orders" : ""}
          FROM sales_daily, a WHERE ${lastDays(":period")} AND ${BR} ORDER BY date DESC, revenue DESC`,
      },
      ...(hasPayment ? [{
        id: "q_drill_pay", name: "Drill: one payment method by day and branch", dataSourceId: lake,
        sql: `WITH a AS (SELECT MAX(date) AS d FROM sales_daily)
          SELECT date, branch, ROUND(SUM(revenue), 2) AS revenue${hasReceipts ? ", SUM(orders) AS orders" : ""}
          FROM payment_daily, a WHERE ${payLabel} = :drill_method AND ${lastDays(":period")} AND ${BR}
          GROUP BY date, branch ORDER BY date DESC, 3 DESC`,
      }] : []),
      {
        id: "q_kpi", name: "Sales vs previous period", dataSourceId: lake,
        sql: `WITH a AS (SELECT MAX(date) AS d FROM sales_daily),
          cur AS (SELECT SUM(revenue) AS rev, ${per.of} AS of_n, ${per.n} AS n FROM sales_daily, a
                  WHERE date > date(a.d, '-' || :period || ' day') AND ${BR}),
          prev AS (SELECT SUM(revenue) AS rev, ${per.of} AS of_n, ${per.n} AS n FROM sales_daily, a
                   WHERE date > date(a.d, '-' || (2 * :period) || ' day') AND date <= date(a.d, '-' || :period || ' day') AND ${BR})
          SELECT ROUND(cur.rev, 2) AS revenue, ROUND(prev.rev, 2) AS revenue_prev,
                 cur.n AS ${per.count}, prev.n AS ${per.count}_prev,
                 ROUND(cur.of_n / NULLIF(cur.n, 0), 2) AS ${per.avg}, ROUND(prev.of_n / NULLIF(prev.n, 0), 2) AS ${per.avg}_prev
          FROM cur, prev`,
      },
      {
        id: "q_day", name: "Latest day vs the day before", dataSourceId: lake,
        sql: `WITH a AS (SELECT MAX(date) AS d FROM sales_daily WHERE ${BR})
          SELECT (SELECT ROUND(SUM(revenue), 2) FROM sales_daily, a WHERE date = a.d AND ${BR}) AS revenue,
                 (SELECT ROUND(SUM(revenue), 2) FROM sales_daily, a WHERE date = date(a.d, '-1 day') AND ${BR}) AS revenue_prev`,
      },
      {
        id: "q_trend", name: "Daily sales and forecast", dataSourceId: lake,
        sql: `WITH a AS (SELECT MAX(date) AS d FROM sales_daily)
          SELECT date, revenue AS ${qi(s.revenue)}, forecast AS ${qi(s.forecast)} FROM (
            SELECT date, ROUND(SUM(revenue), 2) AS revenue, NULL AS forecast FROM sales_daily, a
            WHERE date > date(a.d, '-' || :period || ' day') AND ${BR} GROUP BY date
            UNION ALL
            SELECT date, NULL, ROUND(SUM(forecast_revenue), 2) FROM sales_forecast, a
            WHERE date <= date(a.d, '+14 day') AND ${BR} GROUP BY date
          ) ORDER BY date`,
      },
      {
        id: "q_rank", name: "Branches by sales", dataSourceId: lake,
        sql: `WITH a AS (SELECT MAX(date) AS d FROM sales_daily),
          cur AS (SELECT branch, SUM(revenue) AS rev, ${per.of} AS of_n, ${per.n} AS n FROM sales_daily, a
                  WHERE date > date(a.d, '-' || :period || ' day') GROUP BY branch),
          prev AS (SELECT branch, SUM(revenue) AS rev FROM sales_daily, a
                   WHERE date > date(a.d, '-' || (2 * :period) || ' day') AND date <= date(a.d, '-' || :period || ' day') GROUP BY branch)
          SELECT cur.branch, ROUND(cur.rev, 2) AS revenue, cur.n AS ${per.count}, ROUND(cur.of_n / NULLIF(cur.n, 0), 2) AS ${per.avg},
                 ROUND((cur.rev - prev.rev) * 100.0 / NULLIF(prev.rev, 0), 1) AS growth_pct
          FROM cur LEFT JOIN prev ON prev.branch = cur.branch
          ORDER BY cur.rev DESC`,
      },
      {
        id: "q_weekday", name: "Average sales by weekday", dataSourceId: lake,
        sql: `WITH a AS (SELECT MAX(date) AS d FROM sales_daily),
          days AS (SELECT date, weekday, SUM(revenue) AS rev FROM sales_daily, a
                   WHERE date > date(a.d, '-' || :period || ' day') AND ${BR} GROUP BY date, weekday)
          SELECT ${weekdayName(s)} AS day, ROUND(AVG(rev), 2) AS ${qi(s.revenue)} FROM days GROUP BY weekday ORDER BY weekday`,
      },
      {
        id: "q_money", name: hasReceipts ? "Discounts and items per order vs previous period" : "Discounts vs previous period", dataSourceId: lake,
        // Sales are after discount, so the price before it is sales + discount.
        sql: `WITH a AS (SELECT MAX(date) AS d FROM sales_daily),
          cur AS (SELECT SUM(revenue) AS rev, SUM(discount) AS disc, ${ITEMS_R} AS it, SUM(orders) AS ord FROM sales_daily, a
                  WHERE ${lastDays(":period")} AND ${BR}),
          prev AS (SELECT SUM(revenue) AS rev, SUM(discount) AS disc, ${ITEMS_R} AS it, SUM(orders) AS ord FROM sales_daily, a
                   WHERE date > date(a.d, '-' || (2 * :period) || ' day') AND date <= date(a.d, '-' || :period || ' day') AND ${BR})
          SELECT ROUND(cur.disc, 2) AS discount, ROUND(prev.disc, 2) AS discount_prev,
                 ROUND(cur.disc / NULLIF(cur.rev + cur.disc, 0), 4) AS discount_share, ROUND(prev.disc / NULLIF(prev.rev + prev.disc, 0), 4) AS discount_share_prev${hasReceipts ? `,
                 ROUND(cur.it * 1.0 / NULLIF(cur.ord, 0), 2) AS items_per_order, ROUND(prev.it * 1.0 / NULLIF(prev.ord, 0), 2) AS items_per_order_prev` : ""}
          FROM cur, prev`,
      },
      ...(hasPayment ? [{
        id: "q_pay", name: "How customers pay", dataSourceId: lake,
        sql: `WITH a AS (SELECT MAX(date) AS d FROM sales_daily),
          p AS (SELECT method, SUM(revenue) AS rev, ${REV_R} AS rev_r, SUM(orders) AS ord FROM payment_daily, a
                WHERE ${lastDays(":period")} AND ${BR} GROUP BY method),
          t AS (SELECT SUM(rev) AS rev FROM p)
          SELECT ${payLabel} AS method_label, ROUND(p.rev, 2) AS ${qi(s.revenue)},
                 ROUND(p.rev * 100.0 / NULLIF(t.rev, 0), 1) AS share_pct${hasReceipts ? `, p.ord AS orders, ROUND(p.rev_r / NULLIF(p.ord, 0), 2) AS avg_ticket` : ""}
          FROM p, t ORDER BY p.rev DESC`,
      }] : []),
    ],
    pages: [{
      id: "p1", size: "A4", orientation: "landscape",
      blocks: [
        { id: "b_title", type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: s.overview, subtitle: overviewSub(s, hasReceipts), align: "left" } },
        { id: "k_rev", type: "kpi", x: 0, y: 2, w: 3, h: 3, config: { queryId: "q_kpi", label: s.revenue, valueField: "revenue", compareField: "revenue_prev", format: "currency", drilldown: { queryId: "q_drill_days", title: s.drillDays, columns: dayCols } } },
        { id: per.countId, type: "kpi", x: 3, y: 2, w: 3, h: 3, config: { queryId: "q_kpi", label: per.countLabel, valueField: per.count, compareField: `${per.count}_prev`, format: "number" } },
        { id: per.avgId, type: "kpi", x: 6, y: 2, w: 3, h: 3, config: { queryId: "q_kpi", label: per.avgLabel, valueField: per.avg, compareField: `${per.avg}_prev`, format: "currency" } },
        { id: "k_day", type: "kpi", x: 9, y: 2, w: 3, h: 3, config: { queryId: "q_day", label: s.lastDay, valueField: "revenue", compareField: "revenue_prev", format: "currency" } },
        // Items per order needs orders; without it the two discount figures share the row.
        { id: "k_disc", type: "kpi", x: 0, y: 5, w: hasReceipts ? 4 : 6, h: 3, config: { queryId: "q_money", label: s.discount, valueField: "discount", compareField: "discount_prev", format: "currency" } },
        { id: "k_disc_share", type: "kpi", x: hasReceipts ? 4 : 6, y: 5, w: hasReceipts ? 4 : 6, h: 3, config: { queryId: "q_money", label: s.discountPct, valueField: "discount_share", compareField: "discount_share_prev", format: "percent" } },
        ...(hasReceipts ? [
          { id: "k_ipo", type: "kpi", x: 8, y: 5, w: 4, h: 3, config: { queryId: "q_money", label: s.itemsPerOrder, valueField: "items_per_order", compareField: "items_per_order_prev", format: "number" } },
        ] : []),
        { id: "c_trend", type: "chart", x: 0, y: 8, w: 12, h: 8, config: { queryId: "q_trend", chartType: "line", title: s.trend, xField: "date", yFields: [s.revenue, s.forecast], showLegend: true, valueFormat: "compact" } },
        { id: "c_rank", type: "chart", x: 0, y: 16, w: 6, h: 9, config: { queryId: "q_rank", chartType: "bar", orientation: "horizontal", title: s.ranking, xField: "branch", yFields: ["revenue"], valueFormat: "compact", limit: 30, drillParam: "branch" } },
        {
          id: "t_rank", type: "table", x: 6, y: 16, w: 6, h: 9,
          config: {
            queryId: "q_rank", title: s.ranking, pageSize: 50, stripe: true, showTotals: true, actions: [], drillParam: "branch", drillField: "branch",
            columns: [
              { key: "branch", label: s.branch, type: "string", total: "none" },
              { key: "revenue", label: s.revenue, type: "currency", total: "sum" },
              { key: per.count, label: per.countLabel, type: "number", total: "sum" },
              { key: per.avg, label: per.avgLabel, type: "currency", total: "none" },
              { key: "growth_pct", label: s.growthPct, type: "number", total: "none" },
            ],
          },
        },
        { id: "c_weekday", type: "chart", x: 0, y: 25, w: 12, h: 7, config: { queryId: "q_weekday", chartType: "bar", title: s.weekday, xField: "day", yFields: [s.revenue], valueFormat: "compact" } },
        ...(hasPayment ? [
          { id: "c_pay", type: "chart", x: 0, y: 32, w: 5, h: 8, config: { queryId: "q_pay", chartType: "donut", title: s.payments, xField: "method_label", yFields: [s.revenue], showLegend: true, valueFormat: "compact", drilldown: { queryId: "q_drill_pay", filterParam: "drill_method", title: s.drillPay, columns: dayCols } } },
          {
            id: "t_pay", type: "table", x: 5, y: 32, w: 7, h: 8,
            config: {
              queryId: "q_pay", title: s.payTable, pageSize: 20, stripe: true, showTotals: true, actions: [],
              drilldown: { queryId: "q_drill_pay", filterParam: "drill_method", title: s.drillPay, columns: dayCols }, drillField: "method_label",
              columns: [
                { key: "method_label", label: s.payMethod, type: "string", total: "none" },
                { key: s.revenue, label: s.revenue, type: "currency", total: "sum" },
                { key: "share_pct", label: s.share, type: "number", total: "none" },
                ...(hasReceipts ? [
                  { key: "orders", label: s.orders, type: "number", total: "sum" },
                  { key: "avg_ticket", label: s.avgTicket, type: "currency", total: "none" },
                ] : []),
              ],
            },
          },
        ] : []),
      ],
    }],
  });
}

/**
 * When sales come in and what sells: the weekday × hour heatmap needs
 * times of sale (hasTime); without them the item heatmap goes by weekday.
 */
function insightsReport(s: Strings, branches: string[], hasTime: boolean) {
  const d = R.demandDays;
  // Every (row, column) pair is in the result — a slot with no sales is 0, not missing —
  // so the heatmap's axes keep the query's order (weekday, rank) with no gaps.
  const itemSql = hasTime
    ? `WITH a AS (SELECT MAX(date) AS d FROM sales_daily),
        nd AS (SELECT COUNT(DISTINCT date) AS n FROM sales_daily, a WHERE ${lastDays(d)} AND ${BR}),
        t AS (SELECT rank, hour, SUM(qty) AS q FROM item_by_time WHERE hour IS NOT NULL AND ${BR} GROUP BY rank, hour),
        items AS (SELECT rank, MAX(product) AS product FROM item_by_time GROUP BY rank),
        hrs AS (SELECT DISTINCT hour FROM item_by_time WHERE hour IS NOT NULL AND ${BR})
        SELECT items.product, printf('%02d:00', hrs.hour) AS hour, ROUND(COALESCE(t.q, 0) * 1.0 / nd.n, 1) AS ${qi(s.unitsPerDay)}
        FROM items CROSS JOIN hrs CROSS JOIN nd LEFT JOIN t ON t.rank = items.rank AND t.hour = hrs.hour
        ORDER BY items.rank, hrs.hour`
    : `WITH a AS (SELECT MAX(date) AS d FROM sales_daily),
        nd AS (SELECT weekday, COUNT(DISTINCT date) AS n FROM sales_daily, a WHERE ${lastDays(d)} AND ${BR} GROUP BY weekday),
        t AS (SELECT rank, weekday, SUM(qty) AS q FROM item_by_time WHERE ${BR} GROUP BY rank, weekday),
        items AS (SELECT rank, MAX(product) AS product FROM item_by_time GROUP BY rank)
        SELECT items.product, ${weekdayName(s, "nd.weekday")} AS day, ROUND(COALESCE(t.q, 0) * 1.0 / nd.n, 1) AS ${qi(s.unitsPerDay)}
        FROM items CROSS JOIN nd LEFT JOIN t ON t.rank = items.rank AND t.weekday = nd.weekday
        ORDER BY items.rank, nd.weekday`;
  const changePct = `CASE WHEN MIN(full_compare) = 1 AND SUM(qty_prev) > 0 THEN ROUND((SUM(qty) - SUM(qty_prev)) * 100.0 / SUM(qty_prev), 1) END`;
  return (lake: string) => ({
    version: 1,
    name: S.en.insights,
    nameI18n: nameI18n("insights"),
    description: s.insightsSub,
    parameters: [branchParam(s, branches)],
    dataSources: [
      itemDrillQuery(lake),
      ...(hasTime ? [{
        id: "q_heat_time", name: "Average sales per day by weekday and hour", dataSourceId: lake,
        sql: `WITH a AS (SELECT MAX(date) AS d FROM sales_daily),
          h AS (SELECT weekday, hour, SUM(revenue) AS rev FROM sales_hourly, a WHERE ${lastDays(d)} AND ${BR} GROUP BY weekday, hour),
          nd AS (SELECT weekday, COUNT(DISTINCT date) AS n FROM sales_daily, a WHERE ${lastDays(d)} AND ${BR} GROUP BY weekday),
          hrs AS (SELECT DISTINCT hour FROM h)
          SELECT ${weekdayName(s, "nd.weekday")} AS day, printf('%02d:00', hrs.hour) AS hour,
                 ROUND(COALESCE(h.rev, 0) / nd.n, 2) AS ${qi(s.avgPerDay)}
          FROM nd CROSS JOIN hrs LEFT JOIN h ON h.weekday = nd.weekday AND h.hour = hrs.hour
          ORDER BY nd.weekday, hrs.hour`,
      }] : []),
      { id: "q_heat_item", name: "When the best sellers sell", dataSourceId: lake, sql: itemSql },
      {
        id: "q_best", name: "Best sellers", dataSourceId: lake,
        sql: `WITH t AS (SELECT SUM(revenue) AS rev FROM item_sales WHERE ${BR})
          SELECT MAX(label) AS product, MAX(category) AS category, SUM(qty) AS qty, ROUND(SUM(revenue), 2) AS revenue,
                 ROUND(SUM(revenue) * 100.0 / NULLIF(t.rev, 0), 1) AS share_pct, ROUND(SUM(qty_per_day), 1) AS qty_per_day,
                 ${changePct} AS change_pct
          FROM item_sales, t WHERE ${BR}
          GROUP BY item HAVING SUM(qty) > 0
          ORDER BY SUM(revenue) DESC LIMIT 30`,
      },
      {
        id: "q_top_units", name: "Most units sold", dataSourceId: lake,
        sql: `SELECT MAX(label) AS product, SUM(qty) AS ${qi(s.qty)} FROM item_sales WHERE ${BR}
          GROUP BY item HAVING SUM(qty) > 0 ORDER BY SUM(qty) DESC LIMIT 10`,
      },
      {
        id: "q_rising", name: "Demand rising", dataSourceId: lake,
        sql: `SELECT product, qty, qty_prev, change_pct FROM (
            SELECT MAX(label) AS product, SUM(qty) AS qty, SUM(qty_prev) AS qty_prev, ${changePct} AS change_pct
            FROM item_sales WHERE ${BR} GROUP BY item
          ) WHERE qty >= ${R.risingMinQty} AND change_pct >= ${R.risingMinPct}
          ORDER BY change_pct DESC, qty DESC LIMIT 30`,
      },
    ],
    pages: [{
      id: "p1", size: "A4", orientation: "landscape",
      blocks: (() => {
        const top = hasTime ? 10 : 2;
        return [
          { id: "b_title", type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: s.insights, subtitle: s.insightsSub, align: "left" } },
          ...(hasTime ? [{
            id: "h_time", type: "heatmap", x: 0, y: 2, w: 12, h: 8,
            config: { queryId: "q_heat_time", title: s.heatTime, mode: "grid", xField: "hour", yField: "day", valueField: s.avgPerDay, order: "query", format: "compact" },
          }] : []),
          {
            id: "h_item", type: "heatmap", x: 0, y: top, w: 12, h: 14,
            config: {
              queryId: "q_heat_item", title: hasTime ? s.heatItem : s.heatItemWeekday, mode: "grid",
              xField: hasTime ? "hour" : "day", yField: "product", valueField: s.unitsPerDay, order: "query", format: "compact",
            },
          },
          {
            id: "t_best", type: "table", x: 0, y: top + 14, w: 12, h: 10,
            config: {
              queryId: "q_best", title: s.bestSellers, pageSize: 30, stripe: true, showTotals: false, actions: [], drilldown: itemDrill(s), drillField: "product",
              columns: [
                { key: "product", label: s.product, type: "string", total: "none" },
                { key: "category", label: s.category, type: "string", total: "none" },
                { key: "qty", label: s.qty, type: "number", total: "none" },
                { key: "revenue", label: s.revenue, type: "currency", total: "none" },
                { key: "share_pct", label: s.share, type: "number", total: "none" },
                { key: "qty_per_day", label: s.perDay, type: "number", total: "none" },
                { key: "change_pct", label: s.change, type: "number", total: "none" },
              ],
            },
          },
          { id: "c_top_units", type: "chart", x: 0, y: top + 24, w: 6, h: 9, config: { queryId: "q_top_units", chartType: "bar", orientation: "horizontal", title: s.topUnits, xField: "product", yFields: [s.qty], valueFormat: "number", drilldown: itemDrill(s) } },
          {
            id: "t_rising", type: "table", x: 6, y: top + 24, w: 6, h: 9,
            config: {
              queryId: "q_rising", title: s.rising, pageSize: 30, stripe: true, showTotals: false, actions: [], emptyText: s.risingNone, drilldown: itemDrill(s), drillField: "product",
              columns: [
                { key: "product", label: s.product, type: "string", total: "none" },
                { key: "qty", label: s.qty, type: "number", total: "none" },
                { key: "qty_prev", label: s.qtyPrev, type: "number", total: "none" },
                { key: "change_pct", label: s.change, type: "number", total: "none" },
              ],
            },
          },
          { id: "b_method", type: "text", x: 0, y: top + 33, w: 12, h: 3, config: { text: s.insightsMethod, align: "left", size: "sm" } },
        ];
      })(),
    }],
  });
}

function stockReport(s: Strings, branches: string[]) {
  const statusLabel = caseMap("status", s.statuses);
  return (lake: string) => ({
    version: 1,
    name: S.en.stock,
    nameI18n: nameI18n("stock"),
    description: s.stockSub,
    parameters: [branchParam(s, branches)],
    dataSources: [
      itemDrillQuery(lake),
      {
        id: "q_stock_kpi", name: "Stock summary", dataSourceId: lake,
        sql: `SELECT COALESCE(SUM(status IN ('out', 'reorder')), 0) AS to_order, COALESCE(SUM(status = 'out'), 0) AS out_items,
                     COALESCE(SUM(status = 'slow'), 0) AS slow_items, ROUND(SUM(stock_value), 0) AS stock_value,
                     ROUND(COALESCE(SUM(CASE WHEN status = 'slow' THEN stock_value END), 0), 0) AS slow_value
              FROM stock_status WHERE ${BR}`,
      },
      {
        id: "q_reorder", name: "To order now", dataSourceId: lake,
        sql: `SELECT label, branch, product, on_hand, ROUND(avg_daily_sales, 1) AS avg_daily_sales, days_cover, runout_date, suggested_order_qty, ${statusLabel} AS status_label
              FROM stock_status WHERE status IN ('out', 'reorder') AND ${BR}
              ORDER BY status = 'out' DESC, days_cover ASC, suggested_order_qty DESC LIMIT 500`,
      },
      {
        id: "q_slow", name: "Not selling", dataSourceId: lake,
        sql: `SELECT label, branch, product, on_hand, stock_value, last_sale_date, days_since_last_sale
              FROM stock_status WHERE status = 'slow' AND ${BR}
              ORDER BY stock_value DESC LIMIT 500`,
      },
      {
        id: "q_age", name: "Stock value by days since last sale", dataSourceId: lake,
        sql: `SELECT ${caseMap("age_bucket", { no_sales: s.noSales })} AS age, ROUND(SUM(stock_value), 0) AS ${qi(s.stockValue)}
              FROM stock_status WHERE on_hand > 0 AND ${BR}
              GROUP BY age_bucket
              ORDER BY CASE age_bucket WHEN '0-30' THEN 1 WHEN '31-60' THEN 2 WHEN '61-90' THEN 3 WHEN '91-180' THEN 4 WHEN '181+' THEN 5 ELSE 6 END`,
      },
      {
        id: "q_status", name: "Items by status", dataSourceId: lake,
        sql: `SELECT ${statusLabel} AS status_label, COUNT(*) AS ${qi(s.items)} FROM stock_status WHERE ${BR} GROUP BY status ORDER BY 2 DESC`,
      },
    ],
    pages: [{
      id: "p1", size: "A4", orientation: "landscape",
      blocks: [
        { id: "b_title", type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: s.stock, subtitle: s.stockSub, align: "left" } },
        { id: "k_order", type: "kpi", x: 0, y: 2, w: 3, h: 3, config: { queryId: "q_stock_kpi", label: s.toOrder, valueField: "to_order", format: "number" } },
        { id: "k_out", type: "kpi", x: 3, y: 2, w: 3, h: 3, config: { queryId: "q_stock_kpi", label: s.outItems, valueField: "out_items", format: "number" } },
        { id: "k_value", type: "kpi", x: 6, y: 2, w: 3, h: 3, config: { queryId: "q_stock_kpi", label: s.stockValue, valueField: "stock_value", format: "currency" } },
        { id: "k_slow", type: "kpi", x: 9, y: 2, w: 3, h: 3, config: { queryId: "q_stock_kpi", label: s.slowValue, valueField: "slow_value", format: "currency" } },
        {
          id: "t_reorder", type: "table", x: 0, y: 5, w: 12, h: 10,
          config: {
            queryId: "q_reorder", title: s.reorderList, pageSize: 50, stripe: true, showTotals: false, actions: [], emptyText: s.reorderNone, drilldown: itemDrill(s), drillField: "product",
            columns: [
              { key: "product", label: s.product, type: "string", total: "none" },
              { key: "branch", label: s.branch, type: "string", total: "none" },
              { key: "on_hand", label: s.onHand, type: "number", total: "none" },
              { key: "avg_daily_sales", label: s.perDay, type: "number", total: "none" },
              { key: "days_cover", label: s.cover, type: "number", total: "none" },
              { key: "runout_date", label: s.runout, type: "date", total: "none" },
              { key: "suggested_order_qty", label: s.orderQty, type: "number", total: "sum" },
              { key: "status_label", label: s.status, type: "string", total: "none" },
            ],
          },
        },
        {
          id: "t_slow", type: "table", x: 0, y: 15, w: 12, h: 10,
          config: {
            queryId: "q_slow", title: s.slowList, pageSize: 50, stripe: true, showTotals: true, actions: [], drilldown: itemDrill(s), drillField: "product",
            columns: [
              { key: "product", label: s.product, type: "string", total: "none" },
              { key: "branch", label: s.branch, type: "string", total: "none" },
              { key: "on_hand", label: s.onHand, type: "number", total: "sum" },
              { key: "stock_value", label: s.stockValue, type: "currency", total: "sum" },
              { key: "last_sale_date", label: s.lastSale, type: "date", total: "none" },
              { key: "days_since_last_sale", label: s.daysNoSale, type: "number", total: "none" },
            ],
          },
        },
        { id: "c_age", type: "chart", x: 0, y: 25, w: 7, h: 8, config: { queryId: "q_age", chartType: "bar", title: s.byAge, xField: "age", yFields: [s.stockValue], valueFormat: "compact" } },
        { id: "c_status", type: "chart", x: 7, y: 25, w: 5, h: 8, config: { queryId: "q_status", chartType: "donut", title: s.byStatus, xField: "status_label", yFields: [s.items], showLegend: true } },
      ],
    }],
  });
}

function planReport(s: Strings, branches: string[], hasStock: boolean, hasReceipts: boolean) {
  // Comparing branches needs at least two of them; comparing their tickets
  // and orders needs receipt numbers too.
  const bench = branches.length >= 2;
  const method = s.methodForecast + (hasStock ? s.methodOrders : "") + (bench ? s.methodBench + (hasReceipts ? s.methodUpside : "") : "");
  const d = R.demandDays;
  return (lake: string) => ({
    version: 1,
    name: S.en.plan,
    nameI18n: nameI18n("plan"),
    description: s.planSub,
    parameters: [
      branchParam(s, branches),
      { name: "growth", label: s.growth, type: "number", required: false, default: 5 },
    ],
    dataSources: [
      itemDrillQuery(lake),
      {
        id: "q_plan_kpi", name: "Tomorrow, next 7 days and target", dataSourceId: lake,
        sql: `WITH a AS (SELECT MAX(date) AS d FROM sales_daily),
          nx AS (SELECT SUM(forecast_revenue) AS f FROM sales_forecast, a WHERE date = date(a.d, '+1 day') AND ${BR}),
          f7 AS (SELECT SUM(forecast_revenue) AS f FROM sales_forecast, a WHERE date <= date(a.d, '+7 day') AND ${BR}),
          l7 AS (SELECT SUM(revenue) AS r FROM sales_daily, a WHERE ${lastDays(7)} AND ${BR})
          SELECT ROUND(nx.f, 0) AS tomorrow, ROUND(f7.f, 0) AS forecast_7d, ROUND(f7.f * (1 + :growth / 100.0), 0) AS target_7d, ROUND(l7.r, 0) AS last_7d
          FROM nx, f7, l7`,
      },
      {
        id: "q_targets", name: "Next 7 days: forecast and target", dataSourceId: lake,
        sql: `WITH a AS (SELECT MAX(date) AS d FROM sales_daily),
          fc AS (SELECT branch, SUM(forecast_revenue) AS f FROM sales_forecast, a WHERE date <= date(a.d, '+7 day') AND ${BR} GROUP BY branch),
          last AS (SELECT branch, SUM(revenue) AS r FROM sales_daily, a WHERE date > date(a.d, '-7 day') AND ${BR} GROUP BY branch)
          SELECT fc.branch, ROUND(last.r, 0) AS last_7d, ROUND(fc.f, 0) AS forecast_7d, ROUND(fc.f * (1 + :growth / 100.0), 0) AS target_7d
          FROM fc LEFT JOIN last ON last.branch = fc.branch
          ORDER BY target_7d DESC`,
      },
      {
        id: "q_forecast", name: "Sales forecast, next 28 days", dataSourceId: lake,
        sql: `SELECT date, ROUND(SUM(forecast_revenue), 2) AS ${qi(s.forecast)} FROM sales_forecast WHERE ${BR} GROUP BY date ORDER BY date`,
      },
      ...(bench ? [{
        id: "q_bench", name: "Each branch against the average of all branches", dataSourceId: lake,
        // Always every branch — the average is of all of them. Rates are per selling
        // day, so a branch with a shorter history compares fairly.
        sql: `WITH a AS (SELECT MAX(date) AS d FROM sales_daily),
          cur AS (SELECT branch, SUM(revenue) AS rev, ${REV_R} AS rev_r, SUM(orders) AS ord, ${ITEMS_R} AS it_r,
                         COUNT(DISTINCT date) AS days, ${DAYS_R} AS days_r
                  FROM sales_daily, a WHERE ${lastDays(d)} GROUP BY branch),
          prev AS (SELECT branch, SUM(revenue) AS rev, COUNT(DISTINCT date) AS days FROM sales_daily, a
                   WHERE date > date(a.d, '-${2 * d} day') AND date <= date(a.d, '-${d} day') GROUP BY branch),
          m AS (SELECT branch, rev / days AS per_day, rev_r / NULLIF(ord, 0) AS ticket, it_r * 1.0 / NULLIF(ord, 0) AS ipo, ord * 1.0 / NULLIF(days_r, 0) AS ord_day FROM cur),
          chain AS (SELECT (SELECT AVG(per_day) FROM m) AS per_day, SUM(rev_r) / NULLIF(SUM(ord), 0) AS ticket FROM cur)
          SELECT m.branch, ROUND(m.per_day, 0) AS sales_per_day, ROUND(m.per_day * 100 / chain.per_day, 0) AS sales_index,${hasReceipts ? `
                 ROUND(m.ticket, 2) AS avg_ticket, ROUND(m.ticket * 100 / chain.ticket, 0) AS ticket_index,
                 ROUND(m.ipo, 2) AS items_per_order, ROUND(m.ord_day, 1) AS orders_per_day,
                 ROUND(MAX(chain.ticket - m.ticket, 0) * m.ord_day * 7, 0) AS upside_7d,` : ""}
                 ROUND(((cur.rev / cur.days) / (prev.rev / prev.days) - 1) * 100, 1) AS change_pct
          FROM m JOIN cur ON cur.branch = m.branch CROSS JOIN chain LEFT JOIN prev ON prev.branch = m.branch
          ORDER BY m.per_day DESC`,
      }] : []),
      ...(hasStock ? [{
        id: "q_orders", name: "Order plan", dataSourceId: lake,
        // At the target's pace r: enough for planDays plus the safety days, less
        // what's on hand, ordered by the day cover falls to lead time + safety.
        sql: `WITH p AS (
            SELECT branch, product, on_hand, snapshot_date, lead_time_days AS lead,
                   avg_daily_sales * (1 + :growth / 100.0) AS r
            FROM stock_status WHERE avg_daily_sales > 0 AND ${BR}
          ),
          q AS (SELECT p.*, MAX(on_hand, 0) / r AS cover, ${sqlCeil(`r * ${R.planDays + R.safetyDays} - MAX(on_hand, 0)`)} AS need FROM p)
          SELECT branch, product, on_hand, ROUND(r, 1) AS per_day_target, ROUND(cover, 1) AS days_cover,
                 CASE WHEN on_hand > 0 THEN date(snapshot_date, '+' || CAST(cover AS INTEGER) || ' day') END AS runout_date,
                 date(snapshot_date, '+' || CAST(MAX(cover - lead - ${R.safetyDays}, 0) AS INTEGER) || ' day') AS order_by,
                 need AS order_qty
          FROM q WHERE need > 0
          ORDER BY order_by, runout_date, branch, product LIMIT 500`,
      }] : []),
    ],
    pages: [{
      id: "p1", size: "A4", orientation: "landscape",
      blocks: (() => {
        const benchY = 21;
        const ordersY = bench ? benchY + 7 : benchY;
        return [
        { id: "b_title", type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: s.plan, subtitle: s.planSub, align: "left" } },
        { id: "k_tomorrow", type: "kpi", x: 0, y: 2, w: 4, h: 3, config: { queryId: "q_plan_kpi", label: s.tomorrow, valueField: "tomorrow", format: "currency" } },
        { id: "k_f7", type: "kpi", x: 4, y: 2, w: 4, h: 3, config: { queryId: "q_plan_kpi", label: s.forecast7, valueField: "forecast_7d", compareField: "last_7d", format: "currency" } },
        { id: "k_t7", type: "kpi", x: 8, y: 2, w: 4, h: 3, config: { queryId: "q_plan_kpi", label: s.target7, valueField: "target_7d", compareField: "last_7d", format: "currency" } },
        {
          id: "t_targets", type: "table", x: 0, y: 5, w: 12, h: 8,
          config: {
            queryId: "q_targets", title: s.targets, pageSize: 50, stripe: true, showTotals: true, actions: [], emptyText: s.forecastNone,
            columns: [
              { key: "branch", label: s.branch, type: "string", total: "none" },
              { key: "last_7d", label: s.last7, type: "currency", total: "sum" },
              { key: "forecast_7d", label: s.forecast7, type: "currency", total: "sum" },
              { key: "target_7d", label: s.target7, type: "currency", total: "sum" },
            ],
          },
        },
        { id: "c_forecast", type: "chart", x: 0, y: 13, w: 12, h: 8, config: { queryId: "q_forecast", chartType: "area", title: s.next28, xField: "date", yFields: [s.forecast], valueFormat: "compact" } },
        ...(bench ? [{
          id: "t_bench", type: "table", x: 0, y: benchY, w: 12, h: 7,
          config: {
            queryId: "q_bench", title: s.bench, pageSize: 50, stripe: true, showTotals: false, actions: [],
            columns: [
              { key: "branch", label: s.branch, type: "string", total: "none" },
              { key: "sales_per_day", label: s.salesPerDay, type: "currency", total: "none" },
              { key: "sales_index", label: s.salesIndex, type: "number", total: "none" },
              ...(hasReceipts ? [
                { key: "avg_ticket", label: s.avgTicket, type: "currency", total: "none" },
                { key: "ticket_index", label: s.ticketIndex, type: "number", total: "none" },
                { key: "items_per_order", label: s.itemsPerOrder, type: "number", total: "none" },
                { key: "orders_per_day", label: s.ordersPerDay, type: "number", total: "none" },
              ] : []),
              { key: "change_pct", label: s.benchChange, type: "number", total: "none" },
              ...(hasReceipts ? [{ key: "upside_7d", label: s.upside, type: "currency", total: "none" }] : []),
            ],
          },
        }] : []),
        ...(hasStock ? [{
          id: "t_orders", type: "table", x: 0, y: ordersY, w: 12, h: 10,
          config: {
            queryId: "q_orders", title: s.orderPlan, pageSize: 50, stripe: true, showTotals: false, actions: [], emptyText: s.ordersNone, drilldown: itemDrill(s), drillField: "product",
            columns: [
              { key: "order_by", label: s.orderBy, type: "date", total: "none" },
              { key: "branch", label: s.branch, type: "string", total: "none" },
              { key: "product", label: s.product, type: "string", total: "none" },
              { key: "on_hand", label: s.onHand, type: "number", total: "none" },
              { key: "per_day_target", label: s.perDayTarget, type: "number", total: "none" },
              { key: "days_cover", label: s.cover, type: "number", total: "none" },
              { key: "runout_date", label: s.runout, type: "date", total: "none" },
              { key: "order_qty", label: s.planQty, type: "number", total: "sum" },
            ],
          },
        }] : []),
        { id: "b_method", type: "text", x: 0, y: hasStock ? ordersY + 10 : ordersY, w: 12, h: 4, config: { text: method, align: "left", size: "sm" } },
        ];
      })(),
    }],
  });
}

function basketReport(s: Strings) {
  return (lake: string) => ({
    version: 1,
    name: S.en.basket,
    nameI18n: nameI18n("basket"),
    description: s.basketSub,
    parameters: [],
    dataSources: [
      {
        id: "q_drill_promo", name: "Drill: what sold in the promotion", dataSourceId: lake,
        sql: `SELECT product, SUM(CAST(qty AS REAL)) AS qty, ROUND(SUM(CAST(net_amount AS REAL)), 2) AS revenue,
                     ROUND(SUM(COALESCE(CAST(discount AS REAL), 0)), 2) AS discount
              FROM sales_lines WHERE promo_code = :drill_promo GROUP BY product ORDER BY 3 DESC LIMIT 200`,
      },
      {
        id: "q_pairs", name: "Bought together", dataSourceId: lake,
        sql: `SELECT label, receipts_together, ROUND(confidence_a_to_b * 100, 0) AS a_to_b_pct, ROUND(confidence_b_to_a * 100, 0) AS b_to_a_pct, lift
              FROM basket_pairs WHERE lift >= 1 ORDER BY receipts_together DESC LIMIT 50`,
      },
      {
        id: "q_bundles", name: "Bundle ideas", dataSourceId: lake,
        // Strongly linked and bought together often enough to be worth a shelf.
        sql: `SELECT label, receipts_together, lift, ROUND(confidence_a_to_b * 100, 0) AS a_to_b_pct, ROUND(confidence_b_to_a * 100, 0) AS b_to_a_pct
              FROM basket_pairs WHERE lift >= 1.5 AND receipts_together >= 5 ORDER BY lift DESC, receipts_together DESC LIMIT 30`,
      },
      {
        id: "q_promos", name: "Promotions", dataSourceId: lake,
        sql: `SELECT promo_code, start_date, end_date, revenue, discount, margin, uplift_pct FROM promo_performance ORDER BY start_date DESC LIMIT 200`,
      },
      {
        id: "q_starter", name: "Starting range for a new branch", dataSourceId: lake,
        // Sells in at least half the branches — a proven item, not one branch's local hit.
        sql: `SELECT product, category, branch_share_pct, revenue_per_branch, qty_per_branch_day FROM item_ranking
              WHERE branch_share_pct >= 50 ORDER BY rank LIMIT 100`,
      },
    ],
    pages: [{
      id: "p1", size: "A4", orientation: "landscape",
      blocks: [
        { id: "b_title", type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: s.basket, subtitle: s.basketSub, align: "left" } },
        {
          id: "t_bundles", type: "table", x: 0, y: 2, w: 12, h: 8,
          config: {
            queryId: "q_bundles", title: s.bundles, pageSize: 30, stripe: true, showTotals: false, actions: [], emptyText: s.pairsNone,
            columns: [
              { key: "label", label: s.pair, type: "string", total: "none" },
              { key: "receipts_together", label: s.together, type: "number", total: "none" },
              { key: "a_to_b_pct", label: s.aToB, type: "number", total: "none" },
              { key: "b_to_a_pct", label: s.bToA, type: "number", total: "none" },
              { key: "lift", label: s.lift, type: "number", total: "none" },
            ],
          },
        },
        {
          id: "t_pairs", type: "table", x: 0, y: 10, w: 12, h: 10,
          config: {
            queryId: "q_pairs", title: s.pairs, pageSize: 50, stripe: true, showTotals: false, actions: [], emptyText: s.pairsNone,
            columns: [
              { key: "label", label: s.pair, type: "string", total: "none" },
              { key: "receipts_together", label: s.together, type: "number", total: "none" },
              { key: "a_to_b_pct", label: s.aToB, type: "number", total: "none" },
              { key: "b_to_a_pct", label: s.bToA, type: "number", total: "none" },
              { key: "lift", label: s.lift, type: "number", total: "none" },
            ],
          },
        },
        {
          id: "t_promos", type: "table", x: 0, y: 20, w: 12, h: 9,
          config: {
            queryId: "q_promos", title: s.promos, pageSize: 50, stripe: true, showTotals: true, actions: [], emptyText: s.promosNone,
            drilldown: {
              queryId: "q_drill_promo", filterParam: "drill_promo", title: s.drillPromo,
              columns: [dcol("product", s.product), dcol("qty", s.qty, "number"), dcol("revenue", s.revenue, "currency"), dcol("discount", s.discount, "currency")],
            }, drillField: "promo_code",
            columns: [
              { key: "promo_code", label: s.promo, type: "string", total: "none" },
              { key: "start_date", label: s.start, type: "date", total: "none" },
              { key: "end_date", label: s.end, type: "date", total: "none" },
              { key: "revenue", label: s.revenue, type: "currency", total: "sum" },
              { key: "discount", label: s.discount, type: "currency", total: "sum" },
              { key: "margin", label: s.margin, type: "currency", total: "sum" },
              { key: "uplift_pct", label: s.uplift, type: "number", total: "none" },
            ],
          },
        },
        {
          id: "t_starter", type: "table", x: 0, y: 29, w: 12, h: 10,
          config: {
            queryId: "q_starter", title: s.starter, pageSize: 50, stripe: true, showTotals: false, actions: [],
            columns: [
              { key: "product", label: s.product, type: "string", total: "none" },
              { key: "category", label: s.category, type: "string", total: "none" },
              { key: "branch_share_pct", label: s.branchShare, type: "number", total: "none" },
              { key: "revenue_per_branch", label: s.perBranch, type: "currency", total: "none" },
              { key: "qty_per_branch_day", label: s.qtyPerDay, type: "number", total: "none" },
            ],
          },
        },
        { id: "b_method", type: "text", x: 0, y: 39, w: 12, h: 4, config: { text: s.basketMethod, align: "left", size: "sm" } },
      ],
    }],
  });
}

/**
 * Menu engineering over the last demandDays (item_sales): each item with a
 * cost is popular or not by its share of units (the 70% rule), and earns
 * well or not by its margin per unit against the average — the four
 * classic groups, each with what to do about it. Items without a cost are
 * listed apart, never guessed into a group.
 */
function menuReport(s: Strings, branches: string[]) {
  const G: MenuGroup[] = ["star", "plowhorse", "puzzle", "dog"];
  const STATUS: Record<MenuGroup, string> = { star: "success", puzzle: "info", plowhorse: "warning", dog: "danger" };
  const base = `WITH i AS (
      SELECT item, MAX(label) AS product, MAX(category) AS category, SUM(qty) AS qty, SUM(revenue) AS rev,
             CASE WHEN COUNT(*) = COUNT(cost) THEN SUM(cost) END AS cost
      FROM item_sales WHERE ${BR} GROUP BY item HAVING SUM(qty) > 0
    ),
    c AS (SELECT * FROM i WHERE cost IS NOT NULL AND rev > 0),
    t AS (SELECT COUNT(*) AS n, SUM(qty) AS q, SUM(rev - cost) / SUM(qty) AS cm FROM c),
    m AS (
      SELECT c.*, (rev - cost) / qty AS unit_margin, qty * 1.0 / t.q AS mix,
             CASE WHEN qty * 1.0 / t.q >= 0.7 / t.n
                  THEN CASE WHEN (rev - cost) / qty >= t.cm THEN 'star' ELSE 'plowhorse' END
                  ELSE CASE WHEN (rev - cost) / qty >= t.cm THEN 'puzzle' ELSE 'dog' END END AS grp
      FROM c CROSS JOIN t
    )`;
  return (lake: string) => ({
    version: 1,
    name: S.en.menu,
    nameI18n: nameI18n("menu"),
    description: s.menuSub,
    parameters: [branchParam(s, branches)],
    dataSources: [
      itemDrillQuery(lake),
      {
        id: "q_menu_kpi", name: "Items per group", dataSourceId: lake,
        sql: `${base} SELECT ${G.map((g) => `COALESCE(SUM(grp = '${g}'), 0) AS ${g}`).join(", ")} FROM m`,
      },
      {
        id: "q_menu_tiles", name: "Every item by group", dataSourceId: lake,
        sql: `${base} SELECT product, ${caseMap("grp", s.menuGroups)} AS grp_label, ${caseMap("grp", STATUS)} AS status,
                ROUND(unit_margin, 2) AS unit_margin
              FROM m ORDER BY rev DESC LIMIT 60`,
      },
      {
        id: "q_menu", name: "Items by gross margin", dataSourceId: lake,
        sql: `${base} SELECT product, ${caseMap("grp", s.menuGroups)} AS grp_label, qty, ROUND(mix * 100, 1) AS mix_pct,
                ROUND(rev / qty, 2) AS price, ROUND(cost / qty, 2) AS unit_cost, ROUND(unit_margin, 2) AS unit_margin,
                ROUND((rev - cost) * 100.0 / rev, 1) AS margin_pct, ROUND(rev - cost, 2) AS margin,
                ${caseMap("grp", s.menuAdvice)} AS advice
              FROM m ORDER BY rev - cost DESC LIMIT 200`,
      },
      {
        id: "q_nocost", name: "No cost yet", dataSourceId: lake,
        sql: `WITH i AS (
                SELECT item, MAX(label) AS product, SUM(qty) AS qty, SUM(revenue) AS rev, COUNT(*) AS n, COUNT(cost) AS costed
                FROM item_sales WHERE ${BR} GROUP BY item HAVING SUM(qty) > 0
              )
              SELECT product, qty, ROUND(rev, 2) AS revenue FROM i WHERE costed < n ORDER BY rev DESC LIMIT 200`,
      },
    ],
    pages: [{
      id: "p1", size: "A4", orientation: "landscape",
      blocks: [
        { id: "b_title", type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: s.menu, subtitle: s.menuSub, align: "left" } },
        ...G.map((g, n) => ({
          id: `k_${g}`, type: "kpi", x: n * 3, y: 2, w: 3, h: 3,
          config: { queryId: "q_menu_kpi", label: `${s.menuGroups[g]} · ${s.menuAction[g]}`, valueField: g, format: "number" },
        })),
        {
          id: "h_menu", type: "heatmap", x: 0, y: 5, w: 12, h: 9,
          config: { queryId: "q_menu_tiles", title: s.menuMap, mode: "tiles", labelField: "product", codeField: "grp_label", statusField: "status", valueField: "unit_margin", format: "currency" },
        },
        {
          id: "t_menu", type: "table", x: 0, y: 14, w: 12, h: 11,
          config: {
            queryId: "q_menu", title: s.menuList, pageSize: 50, stripe: true, showTotals: true, actions: [], drilldown: itemDrill(s), drillField: "product",
            columns: [
              { key: "product", label: s.product, type: "string", total: "none" },
              { key: "grp_label", label: s.group, type: "string", total: "none" },
              { key: "qty", label: s.qty, type: "number", total: "sum" },
              { key: "mix_pct", label: s.unitsShare, type: "number", total: "none" },
              { key: "price", label: s.avgPrice, type: "currency", total: "none" },
              { key: "unit_cost", label: s.unitCost, type: "currency", total: "none" },
              { key: "unit_margin", label: s.unitMargin, type: "currency", total: "none" },
              { key: "margin_pct", label: s.marginPct, type: "number", total: "none" },
              { key: "margin", label: s.marginTotal, type: "currency", total: "sum" },
              { key: "advice", label: s.advice, type: "string", total: "none" },
            ],
          },
        },
        {
          id: "t_nocost", type: "table", x: 0, y: 25, w: 12, h: 6,
          config: {
            queryId: "q_nocost", title: s.noCost, pageSize: 50, stripe: true, showTotals: false, actions: [], emptyText: s.noCostNone,
            columns: [
              { key: "product", label: s.product, type: "string", total: "none" },
              { key: "qty", label: s.qty, type: "number", total: "none" },
              { key: "revenue", label: s.revenue, type: "currency", total: "none" },
            ],
          },
        },
        { id: "b_method", type: "text", x: 0, y: 31, w: 12, h: 3, config: { text: s.menuMethod, align: "left", size: "sm" } },
      ],
    }],
  });
}

/**
 * The pack for what this workspace has: sales reports need sales_daily
 * (i.e. sales lines imported), the stock report and its watchers need
 * stock_status (a stock file imported).
 */
export function retailPack(opts: {
  locale: Locale; hasSales: boolean; hasStock: boolean; branches: string[];
  /** From retailCapabilities: times of sale, payment methods, item costs, receipt numbers. */
  hasTime?: boolean; hasPayment?: boolean; hasCost?: boolean; hasReceipts?: boolean;
}): WorkspaceTemplate {
  const s = S[opts.locale] ?? S.en;
  const others = (Object.keys(S) as Locale[]).filter((l) => S[l] !== s);
  /** A report in the setup language, the same report in the others kept as its translations. */
  const inEvery = (build: (s: Strings) => (lake: string) => any) => (lake: string) =>
    withTranslations(build(s)(lake), Object.fromEntries(others.map((l) => [l, build(S[l])(lake)])));
  const reports: WorkspaceTemplate["reports"] = [];
  const watchers: WorkspaceTemplate["watchers"] = [];
  if (opts.hasSales) {
    reports.push({ name: RETAIL_REPORTS.overview, description: overviewSub(s, !!opts.hasReceipts), buildDefinition: inEvery((x) => overviewReport(x, opts.branches, !!opts.hasPayment, !!opts.hasReceipts)) });
    reports.push({ name: RETAIL_REPORTS.insights, description: s.insightsSub, buildDefinition: inEvery((x) => insightsReport(x, opts.branches, !!opts.hasTime)) });
    reports.push({ name: RETAIL_REPORTS.plan, description: s.planSub, buildDefinition: inEvery((x) => planReport(x, opts.branches, opts.hasStock, !!opts.hasReceipts)) });
    reports.push({ name: RETAIL_REPORTS.basket, description: s.basketSub, buildDefinition: inEvery((x) => basketReport(x)) });
    if (opts.hasCost) reports.push({ name: RETAIL_REPORTS.menu, description: s.menuSub, buildDefinition: inEvery((x) => menuReport(x, opts.branches)) });
  }
  if (opts.hasStock) {
    reports.push({ name: RETAIL_REPORTS.stock, description: s.stockSub, buildDefinition: inEvery((x) => stockReport(x, opts.branches)) });
    watchers.push({
      name: s.lowStockWatcher,
      reportName: RETAIL_REPORTS.stock,
      cron: "0 7 * * *",
      config: {
        blockId: "t_reorder", mode: "threshold", metric: "suggested_order_qty", thresholdOp: "gt", thresholdValue: 0, destination: "log",
      },
    });
    watchers.push({
      name: s.slowWatcher,
      reportName: RETAIL_REPORTS.stock,
      cron: "0 8 * * 1",
      config: {
        // Every row of the slow list is a slow mover (in stock, unsold for
        // RETAIL_RULES.slowMoverDays days or never sold) — the watcher reports each one.
        blockId: "t_slow", mode: "threshold", metric: "on_hand", thresholdOp: "gt", thresholdValue: 0, destination: "log",
      },
    });
  }
  return {
    id: "retail",
    name: "Retail",
    description: "Reports and watchers on the workspace's own sales and stock.",
    tables: [],
    reports,
    watchers,
    materializedViews: [],
  };
}
