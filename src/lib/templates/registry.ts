/**
 * Starter templates for common industries. Every template is "bundled" — it
 * pre-wires queries to the seeded sample warehouse (`sample_warehouse`), so
 * "Use template" creates a report with working data out of the box.
 *
 * Users can swap the connection or edit the SQL after creation; the structure
 * stays the same.
 */
import type { Report } from "@/lib/reporting/schema";

export type TemplateLocale = "en" | "th" | "zh";

export type Template = {
  slug: string;
  industry: "finance" | "sales" | "operations" | "hr" | "marketing" | "it" | "retail" | "banking" | "insurance" | "government" | "form" | "general";
  icon: string;
  title: Record<TemplateLocale, string>;
  description: Record<TemplateLocale, string>;
  bundled?: boolean;
  build: (ctx?: { sampleWarehouseId?: string }) => Report;
};

function rid() { return crypto.randomUUID(); }
function page(blocks: any[]): any {
  return { id: rid(), size: "A4", orientation: "portrait", blocks };
}

// ----------------------------------------------------------------------------

export const TEMPLATES: Template[] = [
  {
    slug: "sales-dashboard",
    industry: "sales",
    icon: "TrendingUp",
    bundled: true,
    title: {
      en: "Sales Dashboard",
      th: "แดชบอร์ดฝ่ายขาย",
      zh: "销售仪表板",
    },
    description: {
      en: "Revenue, units, and top products over a date range. Pre-wired to the sample sales table.",
      th: "รายได้ หน่วยขาย และสินค้าขายดี ตามช่วงวันที่ เชื่อมกับตารางขายตัวอย่างแล้ว",
      zh: "按日期范围显示收入、数量和热销产品,已预先连接到示例销售表。",
    },
    build: (ctx) => {
      const ds = ctx?.sampleWarehouseId ?? "";
      return {
        version: 1,
        name: "Sales Dashboard",
        category: "Sales",
        parameters: [
          { name: "from", label: "From", type: "date", default: "2025-06-01", required: true },
          { name: "to",   label: "To",   type: "date", default: "2026-05-31", required: true },
        ],
        dataSources: [
          { id: "ds_total",    name: "Totals",           dataSourceId: ds,
            sql: "SELECT SUM(revenue) AS revenue, SUM(units) AS units FROM sales WHERE sale_date BETWEEN :from AND :to" },
          { id: "ds_by_region",name: "Revenue by region", dataSourceId: ds,
            sql: "SELECT region, SUM(revenue) AS revenue FROM sales s JOIN stores st ON st.id=s.store_id WHERE sale_date BETWEEN :from AND :to GROUP BY region ORDER BY revenue DESC" },
          { id: "ds_products", name: "Top products",      dataSourceId: ds,
            sql: "SELECT p.name AS product, p.category, SUM(s.units) AS units, SUM(s.revenue) AS revenue FROM sales s JOIN products p ON p.id=s.product_id WHERE sale_date BETWEEN :from AND :to GROUP BY p.id ORDER BY revenue DESC LIMIT 15" },
        ],
        pages: [page([
          { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "Sales Dashboard", subtitle: "{{param.from}} to {{param.to}}", align: "left" } },
          { id: rid(), type: "kpi",  x: 0, y: 2, w: 6, h: 3, config: { queryId: "ds_total", label: "Total revenue", valueField: "revenue", format: "currency" } },
          { id: rid(), type: "kpi",  x: 6, y: 2, w: 6, h: 3, config: { queryId: "ds_total", label: "Units sold",    valueField: "units",   format: "number"   } },
          { id: rid(), type: "chart",x: 0, y: 5, w: 12, h: 6, config: { queryId: "ds_by_region", chartType: "bar", xField: "region", yFields: ["revenue"], title: "Revenue by region", stacked: false, showLegend: true } },
          { id: rid(), type: "table",x: 0, y: 11, w: 12, h: 8, config: { queryId: "ds_products", title: "Top products", pageSize: 50, stripe: true, showTotals: true, columns: [
            { key: "product",  label: "Product",  type: "string",   total: "none" },
            { key: "category", label: "Category", type: "string",   total: "none" },
            { key: "units",    label: "Units",    type: "number",   total: "sum"  },
            { key: "revenue",  label: "Revenue",  type: "currency", total: "sum"  },
          ] } },
        ])],
      };
    },
  },
  {
    slug: "financial-pnl",
    industry: "finance",
    icon: "LineChart",
    bundled: true,
    title: {
      en: "Financial P&L",
      th: "งบกำไรขาดทุน (P&L)",
      zh: "损益表",
    },
    description: {
      en: "Revenue, COGS, margin by month and category. Pre-wired to the sample sales warehouse.",
      th: "รายได้ ต้นทุน และกำไร แยกตามเดือนและหมวด เชื่อมข้อมูลจริงจากคลังตัวอย่าง",
      zh: "按月份和类别显示收入、成本和利润,已连接示例数据仓库。",
    },
    build: (ctx) => {
      const ds = ctx?.sampleWarehouseId ?? "";
      return {
        version: 1,
        name: "Financial P&L",
        category: "Finance",
        parameters: [
          { name: "from", label: "From", type: "date", default: "2025-06-01", required: true },
          { name: "to",   label: "To",   type: "date", default: "2026-05-31", required: true },
        ],
        dataSources: [
          { id: "ds_totals", name: "Totals", dataSourceId: ds,
            sql: "SELECT SUM(revenue) AS revenue, SUM(cost) AS cogs, SUM(revenue-cost) AS margin, CASE WHEN SUM(revenue)>0 THEN SUM(revenue-cost)*1.0/SUM(revenue) ELSE 0 END AS margin_pct FROM sales WHERE sale_date BETWEEN :from AND :to" },
          { id: "ds_month",  name: "By month", dataSourceId: ds,
            sql: "SELECT substr(sale_date,1,7) AS month, SUM(revenue) AS revenue, SUM(cost) AS cogs, SUM(revenue-cost) AS margin FROM sales WHERE sale_date BETWEEN :from AND :to GROUP BY month ORDER BY month" },
          { id: "ds_cat",    name: "By category", dataSourceId: ds,
            sql: "SELECT p.category, SUM(s.revenue) AS revenue, SUM(s.cost) AS cogs, SUM(s.revenue-s.cost) AS margin, CASE WHEN SUM(s.revenue)>0 THEN SUM(s.revenue-s.cost)*1.0/SUM(s.revenue) ELSE 0 END AS margin_pct FROM sales s JOIN products p ON p.id=s.product_id WHERE s.sale_date BETWEEN :from AND :to GROUP BY p.category ORDER BY revenue DESC" },
        ],
        pages: [page([
          { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "Financial P&L", subtitle: "{{param.from}} to {{param.to}}", align: "left" } },
          { id: rid(), type: "kpi", x: 0, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Revenue",  valueField: "revenue",    format: "currency" } },
          { id: rid(), type: "kpi", x: 3, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "COGS",     valueField: "cogs",       format: "currency" } },
          { id: rid(), type: "kpi", x: 6, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Margin",   valueField: "margin",     format: "currency" } },
          { id: rid(), type: "kpi", x: 9, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Margin %", valueField: "margin_pct", format: "percent"  } },
          { id: rid(), type: "chart", x: 0, y: 5, w: 12, h: 6, config: { queryId: "ds_month", chartType: "line", xField: "month", yFields: ["revenue","cogs","margin"], title: "Monthly P&L", stacked: false, showLegend: true } },
          { id: rid(), type: "table", x: 0, y: 11, w: 12, h: 8, config: { queryId: "ds_cat", title: "By category", pageSize: 50, stripe: true, showTotals: true, columns: [
            { key: "category",   label: "Category", type: "string",   total: "none" },
            { key: "revenue",    label: "Revenue",  type: "currency", total: "sum"  },
            { key: "cogs",       label: "COGS",     type: "currency", total: "sum"  },
            { key: "margin",     label: "Margin",   type: "currency", total: "sum"  },
            { key: "margin_pct", label: "Margin %", type: "percent",  total: "avg"  },
          ] } },
        ])],
      };
    },
  },
  {
    slug: "inventory-status",
    industry: "operations",
    icon: "Boxes",
    bundled: true,
    title: {
      en: "Inventory Status",
      th: "สถานะคลังสินค้า",
      zh: "库存状态",
    },
    description: {
      en: "Live snapshot of on-hand stock, low-stock alerts, and reorder candidates across stores.",
      th: "สแนปช็อตสินค้าคงคลังสด สินค้าสต็อกต่ำ และรายการสั่งซื้อเพิ่ม จากทุกสาขา",
      zh: "实时库存快照:现有库存、低库存警告和补货候选,覆盖所有门店。",
    },
    build: (ctx) => {
      const ds = ctx?.sampleWarehouseId ?? "";
      return {
        version: 1,
        name: "Inventory Status",
        category: "Operations",
        parameters: [],
        dataSources: [
          { id: "ds_totals", name: "Totals", dataSourceId: ds,
            sql: "SELECT COUNT(DISTINCT product_id) AS skus, SUM(on_hand * p.unit_cost) AS value, SUM(CASE WHEN on_hand<reorder_point THEN 1 ELSE 0 END) AS low FROM inventory i JOIN products p ON p.id=i.product_id" },
          { id: "ds_store", name: "By store", dataSourceId: ds,
            sql: "SELECT st.name AS store, st.region, SUM(i.on_hand) AS on_hand, SUM(i.on_hand * p.unit_cost) AS value, SUM(CASE WHEN i.on_hand<i.reorder_point THEN 1 ELSE 0 END) AS low_skus FROM inventory i JOIN stores st ON st.id=i.store_id JOIN products p ON p.id=i.product_id GROUP BY st.id ORDER BY value DESC" },
          { id: "ds_reorder", name: "Reorder candidates", dataSourceId: ds,
            sql: "SELECT p.sku, p.name AS product, st.name AS store, i.on_hand, i.reorder_point, (i.reorder_point - i.on_hand) AS deficit FROM inventory i JOIN products p ON p.id=i.product_id JOIN stores st ON st.id=i.store_id WHERE i.on_hand < i.reorder_point ORDER BY deficit DESC LIMIT 30" },
        ],
        pages: [page([
          { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "Inventory Status", subtitle: "Live snapshot", align: "left" } },
          { id: rid(), type: "kpi", x: 0, y: 2, w: 4, h: 3, config: { queryId: "ds_totals", label: "Active SKUs",      valueField: "skus",  format: "number"   } },
          { id: rid(), type: "kpi", x: 4, y: 2, w: 4, h: 3, config: { queryId: "ds_totals", label: "Low stock",        valueField: "low",   format: "number"   } },
          { id: rid(), type: "kpi", x: 8, y: 2, w: 4, h: 3, config: { queryId: "ds_totals", label: "Inventory value",  valueField: "value", format: "currency" } },
          { id: rid(), type: "table", x: 0, y: 5, w: 12, h: 7, config: { queryId: "ds_store", title: "By store", pageSize: 50, stripe: true, showTotals: true, columns: [
            { key: "store",    label: "Store",    type: "string",   total: "none" },
            { key: "region",   label: "Region",   type: "string",   total: "none" },
            { key: "on_hand",  label: "On hand",  type: "number",   total: "sum"  },
            { key: "value",    label: "Value",    type: "currency", total: "sum"  },
            { key: "low_skus", label: "Low SKUs", type: "number",   total: "sum"  },
          ] } },
          { id: rid(), type: "table", x: 0, y: 12, w: 12, h: 10, config: { queryId: "ds_reorder", title: "Reorder candidates", pageSize: 50, stripe: true, showTotals: false, columns: [
            { key: "sku",           label: "SKU",           type: "string", total: "none" },
            { key: "product",       label: "Product",       type: "string", total: "none" },
            { key: "store",         label: "Store",         type: "string", total: "none" },
            { key: "on_hand",       label: "On hand",       type: "number", total: "none" },
            { key: "reorder_point", label: "Reorder point", type: "number", total: "none" },
            { key: "deficit",       label: "Deficit",       type: "number", total: "none" },
          ] } },
        ])],
      };
    },
  },
  {
    slug: "hr-headcount",
    industry: "hr",
    icon: "Users",
    bundled: true,
    title: {
      en: "Headcount & Attrition",
      th: "จำนวนพนักงานและอัตราการลาออก",
      zh: "员工人数与流失率",
    },
    description: {
      en: "Team headcount by department, new hires, and attrition rate — wired to the sample employees table.",
      th: "จำนวนพนักงานตามแผนก การจ้างใหม่ และอัตราการลาออก เชื่อมตารางพนักงานตัวอย่าง",
      zh: "按部门显示员工人数、新员工和流失率,已连接示例员工表。",
    },
    build: (ctx) => {
      const ds = ctx?.sampleWarehouseId ?? "";
      return {
        version: 1,
        name: "Headcount & Attrition",
        parameters: [],
        category: "HR",
        dataSources: [
          { id: "ds_totals", name: "Totals", dataSourceId: ds,
            sql: "SELECT (SELECT COUNT(*) FROM employees WHERE end_date IS NULL) AS active, (SELECT COUNT(*) FROM employees WHERE hire_date >= date('now','-365 days')) AS newHires, CASE WHEN (SELECT COUNT(*) FROM employees) > 0 THEN (SELECT COUNT(*) FROM employees WHERE end_date IS NOT NULL AND end_date >= date('now','-365 days')) * 1.0 / (SELECT COUNT(*) FROM employees) ELSE 0 END AS attritionRate" },
          { id: "ds_dept", name: "By department", dataSourceId: ds,
            sql: "SELECT department, COUNT(*) FILTER (WHERE end_date IS NULL) AS headcount, AVG(salary) AS avg_salary FROM employees GROUP BY department ORDER BY headcount DESC" },
        ],
        pages: [page([
          { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "Headcount & Attrition", align: "left" } },
          { id: rid(), type: "kpi", x: 0, y: 2, w: 4, h: 3, config: { queryId: "ds_totals", label: "Active employees", valueField: "active",         format: "number"  } },
          { id: rid(), type: "kpi", x: 4, y: 2, w: 4, h: 3, config: { queryId: "ds_totals", label: "New hires (12mo)", valueField: "newHires",       format: "number"  } },
          { id: rid(), type: "kpi", x: 8, y: 2, w: 4, h: 3, config: { queryId: "ds_totals", label: "Attrition rate",   valueField: "attritionRate",  format: "percent" } },
          { id: rid(), type: "chart", x: 0, y: 5, w: 12, h: 6, config: { queryId: "ds_dept", chartType: "bar", xField: "department", yFields: ["headcount"], title: "Headcount by department", stacked: false, showLegend: true } },
          { id: rid(), type: "table", x: 0, y: 11, w: 12, h: 6, config: { queryId: "ds_dept", title: "By department", pageSize: 50, stripe: true, showTotals: true, columns: [
            { key: "department", label: "Department",  type: "string",   total: "none" },
            { key: "headcount",  label: "Headcount",   type: "number",   total: "sum"  },
            { key: "avg_salary", label: "Avg. salary", type: "currency", total: "avg"  },
          ] } },
        ])],
      };
    },
  },
  {
    slug: "marketing-campaigns",
    industry: "marketing",
    icon: "Megaphone",
    bundled: true,
    title: {
      en: "Marketing Campaign Review",
      th: "สรุปผลแคมเปญการตลาด",
      zh: "营销活动回顾",
    },
    description: {
      en: "Campaign spend, leads, and ROI by channel — wired to the sample campaigns table.",
      th: "งบประมาณ ลีด และ ROI ตามช่องทาง เชื่อมกับตารางแคมเปญตัวอย่าง",
      zh: "按渠道显示广告支出、潜在客户和投资回报率,已连接示例活动表。",
    },
    build: (ctx) => {
      const ds = ctx?.sampleWarehouseId ?? "";
      return {
        version: 1,
        name: "Marketing Campaign Review",
        parameters: [],
        category: "Marketing",
        dataSources: [
          { id: "ds_totals", name: "Totals", dataSourceId: ds,
            sql: "SELECT SUM(spend) AS spend, SUM(leads) AS leads, AVG(roi) AS roi FROM campaigns" },
          { id: "ds_channel", name: "By channel", dataSourceId: ds,
            sql: "SELECT channel, SUM(spend) AS spend, SUM(leads) AS leads, AVG(roi) AS roi FROM campaigns GROUP BY channel ORDER BY spend DESC" },
          { id: "ds_list", name: "Campaigns", dataSourceId: ds,
            sql: "SELECT name AS campaign, channel, spend, leads, roi FROM campaigns ORDER BY spend DESC" },
        ],
        pages: [page([
          { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "Campaign Review", align: "left" } },
          { id: rid(), type: "kpi", x: 0, y: 2, w: 4, h: 3, config: { queryId: "ds_totals", label: "Spend", valueField: "spend", format: "currency" } },
          { id: rid(), type: "kpi", x: 4, y: 2, w: 4, h: 3, config: { queryId: "ds_totals", label: "Leads", valueField: "leads", format: "number"   } },
          { id: rid(), type: "kpi", x: 8, y: 2, w: 4, h: 3, config: { queryId: "ds_totals", label: "Avg ROI", valueField: "roi", format: "number"   } },
          { id: rid(), type: "chart", x: 0, y: 5, w: 12, h: 6, config: { queryId: "ds_channel", chartType: "bar", xField: "channel", yFields: ["leads", "spend"], title: "Leads and spend by channel", stacked: false, showLegend: true } },
          { id: rid(), type: "table", x: 0, y: 11, w: 12, h: 8, config: { queryId: "ds_list", title: "Campaigns", pageSize: 50, stripe: true, showTotals: true, columns: [
            { key: "campaign", label: "Campaign", type: "string",   total: "none" },
            { key: "channel",  label: "Channel",  type: "string",   total: "none" },
            { key: "spend",    label: "Spend",    type: "currency", total: "sum"  },
            { key: "leads",    label: "Leads",    type: "number",   total: "sum"  },
            { key: "roi",      label: "ROI",      type: "number",   total: "avg"  },
          ] } },
        ])],
      };
    },
  },
  {
    slug: "retail-store-performance",
    industry: "retail",
    icon: "Store",
    bundled: true,
    title: {
      en: "Store Performance",
      th: "ผลการดำเนินงานของสาขา",
      zh: "门店业绩",
    },
    description: {
      en: "Store sales, transactions, and per-store revenue breakdown from sample sales data.",
      th: "ยอดขายรายสาขา ธุรกรรม และรายได้ต่อสาขา จากข้อมูลขายตัวอย่าง",
      zh: "每店销售额、交易量、分店收入细分,来自示例销售数据。",
    },
    build: (ctx) => {
      const ds = ctx?.sampleWarehouseId ?? "";
      return {
        version: 1,
        name: "Store Performance",
        category: "Retail",
        parameters: [
          { name: "from", label: "From", type: "date", default: "2025-06-01", required: true },
          { name: "to",   label: "To",   type: "date", default: "2026-05-31", required: true },
        ],
        dataSources: [
          { id: "ds_totals", name: "Totals", dataSourceId: ds,
            sql: "SELECT SUM(revenue) AS sales, COUNT(*) AS transactions FROM sales WHERE sale_date BETWEEN :from AND :to" },
          { id: "ds_store", name: "By store", dataSourceId: ds,
            sql: "SELECT st.name AS store, st.region, SUM(s.revenue) AS sales, COUNT(s.id) AS transactions FROM sales s JOIN stores st ON st.id=s.store_id WHERE sale_date BETWEEN :from AND :to GROUP BY st.id ORDER BY sales DESC" },
        ],
        pages: [page([
          { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "Store Performance", subtitle: "{{param.from}} to {{param.to}}", align: "left" } },
          { id: rid(), type: "kpi", x: 0, y: 2, w: 6, h: 3, config: { queryId: "ds_totals", label: "Sales",        valueField: "sales",        format: "currency" } },
          { id: rid(), type: "kpi", x: 6, y: 2, w: 6, h: 3, config: { queryId: "ds_totals", label: "Transactions", valueField: "transactions", format: "number"   } },
          { id: rid(), type: "chart", x: 0, y: 5, w: 12, h: 6, config: { queryId: "ds_store", chartType: "bar", xField: "store", yFields: ["sales"], title: "Sales by store", stacked: false, showLegend: true } },
          { id: rid(), type: "table", x: 0, y: 11, w: 12, h: 8, config: { queryId: "ds_store", title: "Stores", pageSize: 50, stripe: true, showTotals: true, columns: [
            { key: "store",        label: "Store",        type: "string",   total: "none" },
            { key: "region",       label: "Region",       type: "string",   total: "none" },
            { key: "sales",        label: "Sales",        type: "currency", total: "sum"  },
            { key: "transactions", label: "Transactions", type: "number",   total: "sum"  },
          ] } },
        ])],
      };
    },
  },
  {
    slug: "banking-portfolio",
    industry: "banking",
    icon: "Landmark",
    bundled: true,
    title: {
      en: "Banking Portfolio Overview",
      th: "ภาพรวมพอร์ตธนาคาร",
      zh: "银行业务组合概览",
    },
    description: {
      en: "Deposits, loan book, NIM, and NPL — wired to sample banking monthly metrics and loan products.",
      th: "เงินฝาก พอร์ตสินเชื่อ NIM และหนี้เสีย เชื่อมกับข้อมูลธนาคารรายเดือนตัวอย่าง",
      zh: "存款、贷款、净息差和不良贷款率——已连接示例银行月度指标和贷款产品数据。",
    },
    build: (ctx) => {
      const ds = ctx?.sampleWarehouseId ?? "";
      return {
        version: 1,
        name: "Banking Portfolio Overview",
        parameters: [],
        category: "Banking",
        dataSources: [
          { id: "ds_totals", name: "Totals", dataSourceId: ds,
            sql: "SELECT SUM(deposits) AS deposits, SUM(loans) AS loans, AVG(avg_loan_rate) AS nim, AVG(npl_rate) AS npl FROM banking_monthly WHERE month = (SELECT MAX(month) FROM banking_monthly)" },
          { id: "ds_trend", name: "Monthly trend", dataSourceId: ds,
            sql: "SELECT month, SUM(deposits) AS deposits, SUM(loans) AS loans FROM banking_monthly GROUP BY month ORDER BY month" },
          { id: "ds_products", name: "Loan products", dataSourceId: ds,
            sql: "SELECT product, accounts, balance, avg_rate, npl FROM loan_products ORDER BY balance DESC" },
        ],
        pages: [page([
          { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "Banking Portfolio Overview", align: "left" } },
          { id: rid(), type: "kpi", x: 0, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Deposits", valueField: "deposits", format: "currency" } },
          { id: rid(), type: "kpi", x: 3, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Loans",    valueField: "loans",    format: "currency" } },
          { id: rid(), type: "kpi", x: 6, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "NIM",      valueField: "nim",      format: "percent"  } },
          { id: rid(), type: "kpi", x: 9, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "NPL",      valueField: "npl",      format: "percent"  } },
          { id: rid(), type: "chart", x: 0, y: 5, w: 12, h: 6, config: { queryId: "ds_trend", chartType: "line", xField: "month", yFields: ["deposits","loans"], title: "Deposits vs. loan book", stacked: false, showLegend: true } },
          { id: rid(), type: "table", x: 0, y: 11, w: 12, h: 8, config: { queryId: "ds_products", title: "Loan portfolio by product", pageSize: 50, stripe: true, showTotals: true, columns: [
            { key: "product",  label: "Product",     type: "string",   total: "none" },
            { key: "accounts", label: "Accounts",    type: "number",   total: "sum"  },
            { key: "balance",  label: "Outstanding", type: "currency", total: "sum"  },
            { key: "avg_rate", label: "Avg. rate",   type: "percent",  total: "avg"  },
            { key: "npl",      label: "NPL %",       type: "percent",  total: "avg"  },
          ], actions: [
            { id: "review",  label: "Review",  kind: "log", confirm: true,  confirmLabel: "Flag this product line for review?", config: {} },
            { id: "notify",  label: "Notify",  kind: "log", confirm: false, config: { to: "ops@example.com", subject: "Loan line flagged: {{row.product}}" } },
          ] } },
        ])],
      };
    },
  },
  {
    slug: "insurance-claims",
    industry: "insurance",
    icon: "ShieldCheck",
    bundled: true,
    title: {
      en: "Insurance Claims & Loss Ratio",
      th: "สินไหมและอัตราการสูญเสียประกัน",
      zh: "保险理赔与赔付率",
    },
    description: {
      en: "Active policies, GWP, claims paid, and loss ratio by line — wired to sample policies and claims.",
      th: "กรมธรรม์ที่มีผล เบี้ยรับ สินไหม และอัตราส่วนการสูญเสีย เชื่อมข้อมูลตัวอย่าง",
      zh: "有效保单、总承保保费、已付理赔和赔付率,已连接示例保单与理赔数据。",
    },
    build: (ctx) => {
      const ds = ctx?.sampleWarehouseId ?? "";
      return {
        version: 1,
        name: "Insurance Claims & Loss Ratio",
        parameters: [],
        category: "Insurance",
        dataSources: [
          { id: "ds_totals", name: "Totals", dataSourceId: ds,
            sql: "SELECT (SELECT COUNT(*) FROM policies WHERE status='active') AS policies, (SELECT SUM(premium) FROM policies WHERE status='active') AS gwp, (SELECT SUM(amount) FROM claims) AS claims, CASE WHEN (SELECT SUM(premium) FROM policies WHERE status='active') > 0 THEN (SELECT SUM(amount) FROM claims) * 1.0 / (SELECT SUM(premium) FROM policies WHERE status='active') ELSE 0 END AS lossRatio" },
          { id: "ds_line", name: "By line", dataSourceId: ds,
            sql: "SELECT p.line, COUNT(*) FILTER (WHERE p.status='active') AS policies, SUM(CASE WHEN p.status='active' THEN p.premium ELSE 0 END) AS gwp, (SELECT COALESCE(SUM(amount),0) FROM claims c WHERE c.line = p.line) AS claims, CASE WHEN SUM(CASE WHEN p.status='active' THEN p.premium ELSE 0 END) > 0 THEN (SELECT COALESCE(SUM(amount),0) FROM claims c WHERE c.line = p.line) * 1.0 / SUM(CASE WHEN p.status='active' THEN p.premium ELSE 0 END) ELSE 0 END AS lossRatio FROM policies p GROUP BY p.line ORDER BY gwp DESC" },
          { id: "ds_month", name: "Monthly claims", dataSourceId: ds,
            sql: "SELECT substr(claim_date,1,7) AS month, SUM(amount) AS claims FROM claims GROUP BY month ORDER BY month" },
        ],
        pages: [page([
          { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "Claims & Loss Ratio", align: "left" } },
          { id: rid(), type: "kpi", x: 0, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Active policies", valueField: "policies",  format: "number"   } },
          { id: rid(), type: "kpi", x: 3, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "GWP",             valueField: "gwp",       format: "currency" } },
          { id: rid(), type: "kpi", x: 6, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Claims paid",     valueField: "claims",    format: "currency" } },
          { id: rid(), type: "kpi", x: 9, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Loss ratio",      valueField: "lossRatio", format: "percent"  } },
          { id: rid(), type: "chart", x: 0, y: 5, w: 12, h: 6, config: { queryId: "ds_month", chartType: "area", xField: "month", yFields: ["claims"], title: "Claims over time", stacked: false, showLegend: true } },
          { id: rid(), type: "table", x: 0, y: 11, w: 12, h: 8, config: { queryId: "ds_line", title: "By line of business", pageSize: 50, stripe: true, showTotals: true, columns: [
            { key: "line",      label: "Line",         type: "string",   total: "none" },
            { key: "policies",  label: "Policies",     type: "number",   total: "sum"  },
            { key: "gwp",       label: "GWP",          type: "currency", total: "sum"  },
            { key: "claims",    label: "Claims paid",  type: "currency", total: "sum"  },
            { key: "lossRatio", label: "Loss ratio",   type: "percent",  total: "avg"  },
          ] } },
        ])],
      };
    },
  },
  {
    slug: "government-budget",
    industry: "government",
    icon: "Building2",
    bundled: true,
    title: {
      en: "Public Budget Execution",
      th: "การเบิกจ่ายงบประมาณภาครัฐ",
      zh: "公共预算执行情况",
    },
    description: {
      en: "Budget vs. actual by department, services delivered, and execution rate — wired to the sample departments table.",
      th: "งบประมาณเทียบกับการใช้จริงตามหน่วยงาน บริการประชาชน และอัตราการเบิกจ่าย เชื่อมกับตารางตัวอย่าง",
      zh: "按部门显示预算与实际支出、公共服务和执行率,已连接示例部门表。",
    },
    build: (ctx) => {
      const ds = ctx?.sampleWarehouseId ?? "";
      return {
        version: 1,
        name: "Public Budget Execution",
        parameters: [],
        category: "Government",
        dataSources: [
          { id: "ds_totals", name: "Totals", dataSourceId: ds,
            sql: "SELECT SUM(budget) AS approved, SUM(spent) AS spent, CASE WHEN SUM(budget)>0 THEN SUM(spent)*1.0/SUM(budget) ELSE 0 END AS executionRate, SUM(services) AS services FROM departments" },
          { id: "ds_dept", name: "By department", dataSourceId: ds,
            sql: "SELECT name AS department, budget AS approved, spent, (budget - spent) AS variance, CASE WHEN budget>0 THEN spent*1.0/budget ELSE 0 END AS executionRate FROM departments ORDER BY approved DESC" },
        ],
        pages: [page([
          { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "Budget Execution", align: "left" } },
          { id: rid(), type: "kpi", x: 0, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Approved",     valueField: "approved",      format: "currency" } },
          { id: rid(), type: "kpi", x: 3, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Spent",        valueField: "spent",         format: "currency" } },
          { id: rid(), type: "kpi", x: 6, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Execution %",  valueField: "executionRate", format: "percent"  } },
          { id: rid(), type: "kpi", x: 9, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Services",     valueField: "services",      format: "number"   } },
          { id: rid(), type: "chart", x: 0, y: 5, w: 12, h: 6, config: { queryId: "ds_dept", chartType: "bar", xField: "department", yFields: ["approved","spent"], title: "Budget vs. actual by department", stacked: false, showLegend: true } },
          { id: rid(), type: "table", x: 0, y: 11, w: 12, h: 8, config: { queryId: "ds_dept", title: "Department breakdown", pageSize: 50, stripe: true, showTotals: true, columns: [
            { key: "department",    label: "Department",  type: "string",   total: "none" },
            { key: "approved",      label: "Approved",    type: "currency", total: "sum"  },
            { key: "spent",         label: "Spent",       type: "currency", total: "sum"  },
            { key: "variance",      label: "Variance",    type: "currency", total: "sum"  },
            { key: "executionRate", label: "Execution %", type: "percent",  total: "avg"  },
          ] } },
        ])],
      };
    },
  },
  {
    slug: "form-invoice",
    industry: "form",
    icon: "ReceiptText",
    bundled: true,
    title: {
      en: "Invoice",
      th: "ใบแจ้งหนี้",
      zh: "发票",
    },
    description: {
      en: "Billing document with sender/recipient blocks, line items from sales data, and totals.",
      th: "เอกสารเรียกเก็บเงิน พร้อมข้อมูลผู้ส่ง/ผู้รับ รายการจากข้อมูลการขาย และยอดรวม",
      zh: "含发件方/收件方区块的账单文档,行项目来自销售数据,并附小计与总计。",
    },
    build: (ctx) => {
      const ds = ctx?.sampleWarehouseId ?? "";
      return {
        version: 1,
        name: "Invoice",
        category: "Form",
      display: "page",
        parameters: [
          { name: "invoiceNumber", label: "Invoice #",   type: "string", default: "INV-2026-00042", required: true },
          { name: "issueDate",     label: "Issue date",  type: "date",   default: "2026-04-23",     required: true },
          { name: "dueDate",       label: "Due date",    type: "date",   default: "2026-05-23",     required: true },
          { name: "customerId",    label: "Customer #",  type: "number", default: 1,                required: true },
        ],
        dataSources: [
          { id: "ds_items", name: "Line items", dataSourceId: ds,
            sql: "SELECT p.name AS item, p.sku, s.units AS qty, p.unit_price AS rate, s.revenue AS amount FROM sales s JOIN products p ON p.id=s.product_id WHERE s.customer_id = :customerId ORDER BY s.sale_date DESC LIMIT 12" },
          { id: "ds_totals", name: "Totals", dataSourceId: ds,
            sql: "SELECT SUM(s.revenue) AS subtotal, SUM(s.revenue) * 0.07 AS tax, SUM(s.revenue) * 1.07 AS total FROM sales s WHERE s.customer_id = :customerId" },
          { id: "ds_customer", name: "Customer", dataSourceId: ds,
            sql: "SELECT name, region, tier FROM customers WHERE id = :customerId" },
        ],
        pages: [page([
          { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "INVOICE", subtitle: "#{{param.invoiceNumber}} · Issued {{param.issueDate}}", align: "right" } },
          { id: rid(), type: "divider", x: 0, y: 2, w: 12, h: 1, config: { style: "solid", thickness: 1 } },
          { id: rid(), type: "text",  x: 0, y: 3, w: 6, h: 4, config: { text: "FROM\nYour Company Ltd.\n123 Business Ave\nCity, Country\nTax ID: XX-XXXX-XX", align: "left", size: "sm" } },
          { id: rid(), type: "table", x: 6, y: 3, w: 6, h: 4, config: { queryId: "ds_customer", title: "BILL TO", pageSize: 1, stripe: false, showTotals: false, columns: [
            { key: "name",   label: "Customer", type: "string", total: "none" },
            { key: "tier",   label: "Tier",     type: "string", total: "none" },
            { key: "region", label: "Region",   type: "string", total: "none" },
          ] } },
          { id: rid(), type: "table", x: 0, y: 7, w: 12, h: 10, config: { queryId: "ds_items", title: "Items", pageSize: 50, stripe: true, showTotals: true, columns: [
            { key: "item",   label: "Item",        type: "string",   total: "none" },
            { key: "sku",    label: "SKU",         type: "string",   total: "none" },
            { key: "qty",    label: "Qty",         type: "number",   total: "sum"  },
            { key: "rate",   label: "Rate",        type: "currency", total: "none" },
            { key: "amount", label: "Amount",      type: "currency", total: "sum"  },
          ] } },
          { id: rid(), type: "kpi", x: 6, y: 17, w: 3, h: 3, config: { queryId: "ds_totals", label: "Subtotal",     valueField: "subtotal", format: "currency" } },
          { id: rid(), type: "kpi", x: 9, y: 17, w: 3, h: 3, config: { queryId: "ds_totals", label: "Total (inc. tax)", valueField: "total", format: "currency" } },
          { id: rid(), type: "text", x: 0, y: 20, w: 12, h: 2, config: { text: "Payment terms: Net 30. Make cheques payable to Your Company Ltd. Please include invoice number on payment.", align: "left", size: "sm" } },
        ])],
      };
    },
  },
  {
    slug: "form-billing-statement",
    industry: "form",
    icon: "FileText",
    bundled: true,
    title: {
      en: "Billing Statement",
      th: "ใบแจ้งยอดบัญชี",
      zh: "账单对账单",
    },
    description: {
      en: "Monthly customer statement with account summary, transaction history, and balance due.",
      th: "ใบแจ้งยอดรายเดือนของลูกค้า สรุปบัญชี ประวัติธุรกรรม และยอดค้างชำระ",
      zh: "月度客户对账单,含账户摘要、交易历史和未付余额。",
    },
    build: (ctx) => {
      const ds = ctx?.sampleWarehouseId ?? "";
      return {
        version: 1,
        name: "Billing Statement",
        category: "Form",
      display: "page",
        parameters: [
          { name: "customerId", label: "Customer #", type: "number", default: 1,            required: true },
          { name: "from",       label: "From",       type: "date",   default: "2026-01-01", required: true },
          { name: "to",         label: "To",         type: "date",   default: "2026-04-30", required: true },
        ],
        dataSources: [
          { id: "ds_customer", name: "Customer", dataSourceId: ds,
            sql: "SELECT id, name, region, tier FROM customers WHERE id = :customerId" },
          { id: "ds_summary", name: "Summary", dataSourceId: ds,
            sql: "SELECT COUNT(*) AS transactions, SUM(revenue) AS charges, SUM(revenue) * 1.07 AS balance_due FROM sales WHERE customer_id = :customerId AND sale_date BETWEEN :from AND :to" },
          { id: "ds_tx", name: "Transactions", dataSourceId: ds,
            sql: "SELECT s.sale_date, p.name AS description, s.units AS qty, s.revenue AS amount FROM sales s JOIN products p ON p.id=s.product_id WHERE s.customer_id = :customerId AND s.sale_date BETWEEN :from AND :to ORDER BY s.sale_date DESC" },
        ],
        pages: [page([
          { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "BILLING STATEMENT", subtitle: "{{param.from}} to {{param.to}}", align: "left" } },
          { id: rid(), type: "divider", x: 0, y: 2, w: 12, h: 1, config: { style: "solid", thickness: 1 } },
          { id: rid(), type: "table", x: 0, y: 3, w: 12, h: 3, config: { queryId: "ds_customer", title: "Account", pageSize: 1, stripe: false, showTotals: false, columns: [
            { key: "id",     label: "Account #", type: "string", total: "none" },
            { key: "name",   label: "Customer",  type: "string", total: "none" },
            { key: "tier",   label: "Tier",      type: "string", total: "none" },
            { key: "region", label: "Region",    type: "string", total: "none" },
          ] } },
          { id: rid(), type: "kpi", x: 0, y: 6, w: 4, h: 3, config: { queryId: "ds_summary", label: "Transactions", valueField: "transactions", format: "number"   } },
          { id: rid(), type: "kpi", x: 4, y: 6, w: 4, h: 3, config: { queryId: "ds_summary", label: "Charges",      valueField: "charges",      format: "currency" } },
          { id: rid(), type: "kpi", x: 8, y: 6, w: 4, h: 3, config: { queryId: "ds_summary", label: "Balance due",  valueField: "balance_due",  format: "currency" } },
          { id: rid(), type: "table", x: 0, y: 9, w: 12, h: 11, config: { queryId: "ds_tx", title: "Transactions", pageSize: 50, stripe: true, showTotals: true, columns: [
            { key: "sale_date",   label: "Date",        type: "date",     total: "none" },
            { key: "description", label: "Description", type: "string",   total: "none" },
            { key: "qty",         label: "Qty",         type: "number",   total: "sum"  },
            { key: "amount",      label: "Amount",      type: "currency", total: "sum"  },
          ] } },
          { id: rid(), type: "text", x: 0, y: 20, w: 12, h: 2, config: { text: "Please remit the balance due by {{param.to}} to avoid late fees. Questions? Email billing@example.com.", align: "left", size: "sm" } },
        ])],
      };
    },
  },
  {
    slug: "form-memo",
    industry: "form",
    icon: "Notebook",
    bundled: false,
    title: {
      en: "Memo",
      th: "บันทึกข้อความ",
      zh: "备忘录",
    },
    description: {
      en: "Internal memorandum with TO / FROM / DATE / SUBJECT header and body. Parameter-driven; no queries needed.",
      th: "บันทึกข้อความภายใน พร้อมหัวเรื่อง TO/FROM/DATE/SUBJECT และเนื้อหา ใช้พารามิเตอร์ ไม่ต้องใช้ฐานข้อมูล",
      zh: "内部备忘录,含 TO/FROM/DATE/SUBJECT 信息与正文。由参数驱动,无需查询。",
    },
    build: () => ({
      version: 1,
      name: "Memo",
      category: "Form",
      display: "page",
      parameters: [
        { name: "to",      label: "To",      type: "string", default: "All staff",               required: true },
        { name: "from",    label: "From",    type: "string", default: "Management",              required: true },
        { name: "date",    label: "Date",    type: "date",   default: "2026-04-23",              required: true },
        { name: "subject", label: "Subject", type: "string", default: "Quarterly update",        required: true },
      ],
      dataSources: [],
      pages: [page([
        { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "MEMORANDUM", align: "center" } },
        { id: rid(), type: "divider", x: 0, y: 2, w: 12, h: 1, config: { style: "solid", thickness: 1 } },
        { id: rid(), type: "text", x: 0, y: 3, w: 12, h: 4, config: { text: "TO:        {{param.to}}\nFROM:      {{param.from}}\nDATE:      {{param.date}}\nSUBJECT:   {{param.subject}}", align: "left", size: "md" } },
        { id: rid(), type: "divider", x: 0, y: 7, w: 12, h: 1, config: { style: "solid", thickness: 1 } },
        { id: rid(), type: "text", x: 0, y: 8, w: 12, h: 14, config: { text: "Replace this body text with your message.\n\nUse the parameter bar above the canvas to set TO / FROM / DATE / SUBJECT, or edit the text block directly to hard-code the values.", align: "left", size: "md" } },
      ])],
    }),
  },
  {
    slug: "form-purchase-order",
    industry: "form",
    icon: "ClipboardList",
    bundled: true,
    title: {
      en: "Purchase Order",
      th: "ใบสั่งซื้อ",
      zh: "采购订单",
    },
    description: {
      en: "Standard PO form with buyer/vendor blocks, ordered items table, and totals.",
      th: "ใบสั่งซื้อมาตรฐาน พร้อมข้อมูลผู้ซื้อ/ผู้ขาย ตารางรายการสินค้า และยอดรวม",
      zh: "标准采购订单表单,含买方/卖方区块、订购项目表和总计。",
    },
    build: (ctx) => {
      const ds = ctx?.sampleWarehouseId ?? "";
      return {
        version: 1,
        name: "Purchase Order",
        category: "Form",
      display: "page",
        parameters: [
          { name: "poNumber",   label: "PO #",       type: "string", default: "PO-2026-00123", required: true },
          { name: "issueDate",  label: "Issue date", type: "date",   default: "2026-04-23",    required: true },
          { name: "vendor",     label: "Vendor",     type: "string", default: "Acme Supplies", required: true },
          { name: "limit",      label: "Items",      type: "number", default: 10,              required: false },
        ],
        dataSources: [
          { id: "ds_items", name: "Items", dataSourceId: ds,
            sql: "SELECT p.name AS item, p.sku, 10 AS qty, p.unit_cost AS rate, p.unit_cost * 10 AS amount FROM products p ORDER BY p.unit_cost DESC LIMIT :limit" },
          { id: "ds_totals", name: "Totals", dataSourceId: ds,
            sql: "SELECT SUM(p.unit_cost * 10) AS subtotal, SUM(p.unit_cost * 10) * 0.07 AS tax, SUM(p.unit_cost * 10) * 1.07 AS total FROM (SELECT unit_cost FROM products ORDER BY unit_cost DESC LIMIT :limit) p" },
        ],
        pages: [page([
          { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "PURCHASE ORDER", subtitle: "#{{param.poNumber}} · {{param.issueDate}}", align: "right" } },
          { id: rid(), type: "divider", x: 0, y: 2, w: 12, h: 1, config: { style: "solid", thickness: 1 } },
          { id: rid(), type: "text", x: 0, y: 3, w: 6, h: 4, config: { text: "BUYER\nYour Company Ltd.\n123 Business Ave\nCity, Country", align: "left", size: "sm" } },
          { id: rid(), type: "text", x: 6, y: 3, w: 6, h: 4, config: { text: "VENDOR\n{{param.vendor}}\nPlease quote PO # on all correspondence.", align: "left", size: "sm" } },
          { id: rid(), type: "table", x: 0, y: 7, w: 12, h: 10, config: { queryId: "ds_items", title: "Items ordered", pageSize: 50, stripe: true, showTotals: true, columns: [
            { key: "item",   label: "Item",   type: "string",   total: "none" },
            { key: "sku",    label: "SKU",    type: "string",   total: "none" },
            { key: "qty",    label: "Qty",    type: "number",   total: "sum"  },
            { key: "rate",   label: "Unit cost", type: "currency", total: "none" },
            { key: "amount", label: "Amount", type: "currency", total: "sum"  },
          ] } },
          { id: rid(), type: "kpi", x: 6, y: 17, w: 3, h: 3, config: { queryId: "ds_totals", label: "Subtotal", valueField: "subtotal", format: "currency" } },
          { id: rid(), type: "kpi", x: 9, y: 17, w: 3, h: 3, config: { queryId: "ds_totals", label: "Total",    valueField: "total",    format: "currency" } },
          { id: rid(), type: "text", x: 0, y: 20, w: 12, h: 2, config: { text: "Ship to: Your Company Ltd., attn. Receiving. Terms: Net 30. Authorized by: __________________________", align: "left", size: "sm" } },
        ])],
      };
    },
  },
  {
    slug: "form-receipt",
    industry: "form",
    icon: "Receipt",
    bundled: true,
    title: {
      en: "Receipt",
      th: "ใบเสร็จรับเงิน",
      zh: "收据",
    },
    description: {
      en: "Single-page receipt with items, subtotal, tax, and total. Smaller form for walk-in sales.",
      th: "ใบเสร็จแบบหน้าเดียว มีรายการ ยอดรวม ภาษี และยอดสุทธิ เหมาะสำหรับการขายหน้าร้าน",
      zh: "单页收据,含项目、小计、税额与总计。适用于门店销售的简短表单。",
    },
    build: (ctx) => {
      const ds = ctx?.sampleWarehouseId ?? "";
      return {
        version: 1,
        name: "Receipt",
        category: "Form",
      display: "page",
        parameters: [
          { name: "receiptNumber", label: "Receipt #", type: "string", default: "R-2026-0098", required: true },
          { name: "issueDate",     label: "Date",      type: "date",   default: "2026-04-23",  required: true },
          { name: "storeId",       label: "Store #",   type: "number", default: 1,             required: true },
        ],
        dataSources: [
          { id: "ds_items", name: "Items", dataSourceId: ds,
            sql: "SELECT p.name AS item, s.units AS qty, p.unit_price AS rate, s.revenue AS amount FROM sales s JOIN products p ON p.id=s.product_id WHERE s.store_id = :storeId ORDER BY s.sale_date DESC LIMIT 5" },
          { id: "ds_totals", name: "Totals", dataSourceId: ds,
            sql: "SELECT subtotal, subtotal * 0.07 AS tax, subtotal * 1.07 AS total FROM (SELECT SUM(revenue) AS subtotal FROM sales WHERE store_id = :storeId ORDER BY sale_date DESC LIMIT 5)" },
        ],
        pages: [page([
          { id: rid(), type: "title", x: 0, y: 0, w: 12, h: 2, config: { text: "RECEIPT", subtitle: "#{{param.receiptNumber}} · {{param.issueDate}}", align: "center" } },
          { id: rid(), type: "text", x: 0, y: 2, w: 12, h: 2, config: { text: "Thank you for your purchase.\nStore #{{param.storeId}}", align: "center", size: "sm" } },
          { id: rid(), type: "divider", x: 0, y: 4, w: 12, h: 1, config: { style: "dashed", thickness: 1 } },
          { id: rid(), type: "table", x: 0, y: 5, w: 12, h: 6, config: { queryId: "ds_items", pageSize: 50, stripe: false, showTotals: true, columns: [
            { key: "item",   label: "Item",   type: "string",   total: "none" },
            { key: "qty",    label: "Qty",    type: "number",   total: "sum"  },
            { key: "rate",   label: "Rate",   type: "currency", total: "none" },
            { key: "amount", label: "Amount", type: "currency", total: "sum"  },
          ] } },
          { id: rid(), type: "divider", x: 0, y: 11, w: 12, h: 1, config: { style: "dashed", thickness: 1 } },
          { id: rid(), type: "kpi", x: 0, y: 12, w: 4, h: 3, config: { queryId: "ds_totals", label: "Subtotal", valueField: "subtotal", format: "currency" } },
          { id: rid(), type: "kpi", x: 4, y: 12, w: 4, h: 3, config: { queryId: "ds_totals", label: "Tax 7%",   valueField: "tax",      format: "currency" } },
          { id: rid(), type: "kpi", x: 8, y: 12, w: 4, h: 3, config: { queryId: "ds_totals", label: "Total",    valueField: "total",    format: "currency" } },
          { id: rid(), type: "text", x: 0, y: 15, w: 12, h: 2, config: { text: "Paid in full. Keep this receipt for your records.", align: "center", size: "sm" } },
        ])],
      };
    },
  },
];

export function getTemplate(slug: string): Template | undefined {
  return TEMPLATES.find((t) => t.slug === slug);
}
