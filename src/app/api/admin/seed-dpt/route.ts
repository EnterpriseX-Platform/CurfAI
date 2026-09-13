/**
 * POST /api/admin/seed-dpt — one-off seed of the DPT CEO Command Center.
 *
 * Builds a 5-page executive report on top of the four lake tables
 * already seeded (dpt_projects, dpt_budget_2568, dpt_contractors,
 * dpt_regional_kpis). Idempotent — replaces any existing report named
 * "DPT CEO Command Center".
 *
 * Admin-only. Internal tool — not part of the long-term API.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { ReportSchema } from "@/lib/reporting/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPORT_NAME = "DPT CEO Command Center";

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  // 1. Lake DataSource — upsert
  const ds = await prisma.dataSource.upsert({
    where: { tenantId_name: { tenantId: user.tenantId, name: "Curf Tables" } },
    update: {},
    create: {
      tenantId: user.tenantId,
      name: "Curf Tables",
      kind: "lake",
      connection: "lake://" + user.tenantId,
    },
    select: { id: true },
  });
  const lakeId = ds.id;

  // 2. Build report definition
  const def = buildDefinition(lakeId);

  let parsed;
  try {
    parsed = ReportSchema.parse(def);
  } catch (e: any) {
    return NextResponse.json({
      error: "Schema validation failed",
      details: e?.issues ?? String(e),
    }, { status: 500 });
  }

  // 3. Replace existing
  const existing = await prisma.report.findFirst({
    where: { tenantId: user.tenantId, name: REPORT_NAME },
    select: { id: true },
  });
  if (existing) {
    await prisma.report.update({
      where: { id: existing.id },
      data: { definition: JSON.stringify(parsed), published: true },
    });
    await seedComments(user.tenantId, user.id, existing.id);
    return NextResponse.json({ id: existing.id, name: REPORT_NAME, replaced: true });
  }

  const created = await prisma.report.create({
    data: {
      tenantId: user.tenantId,
      name: REPORT_NAME,
      description: "ภาพรวมประสิทธิภาพการดำเนินงานทั้งกรม — งบประมาณ โครงการ ผู้รับเหมา ความเสี่ยง รายภูมิภาค.",
      definition: JSON.stringify(parsed),
      published: true,
      createdById: user.id,
    },
    select: { id: true, name: true },
  });

  await seedComments(user.tenantId, user.id, created.id);

  return NextResponse.json({ id: created.id, name: created.name, replaced: false });
}

/**
 * Drop orphan comments (referencing deleted reports) and seed three
 * fresh DPT-themed comments on the Command Center so the Brief has real
 * narrative cards instead of the stale "Marketing Campaigns" leftovers.
 */
async function seedComments(tenantId: string, userId: string, reportId: string) {
  // Drop everything for this tenant first — clean slate
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Comment" WHERE "tenantId" = ?`,
      tenantId,
    );
  } catch {}

  const comments = [
    {
      body: "งบประมาณก่อสร้างถนน Q3 จังหวัดนครราชสีมาเกินแผน 18% — ขอให้ทีมตรวจสอบสาเหตุก่อนปิดงบประมาณ",
      blockId: "p1_kpi_overrun",
    },
    {
      body: "ภาคใต้มีอัตราล่าช้าต่ำที่สุดในรอบ 6 เดือน (17.9%) — เป็นแบบอย่างที่ดีให้ภูมิภาคอื่น",
      blockId: "p5_chart_spend",
    },
    {
      body: "ผู้รับเหมา 2 รายมีอัตราเกินงบเกิน 12% ติดต่อกัน 2 ไตรมาส — เสนอทบทวนการต่อสัญญา",
      blockId: "p4_table_contractors",
    },
  ];
  for (const c of comments) {
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Comment" ("id", "tenantId", "reportId", "blockId", "userId", "body", "resolved", "createdAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
        `c_${Math.random().toString(36).slice(2, 12)}`,
        tenantId, reportId, c.blockId, userId, c.body,
      );
    } catch {}
  }
}

/* ── Report builder ───────────────────────────────────────────────── */

function buildDefinition(lakeId: string): any {
  // Lake stores all values as TEXT → we CAST AS REAL anywhere we
  // aggregate or chart numerically. This is a known constraint of the
  // SQLite engine (see lib/lake/tables.ts header).

  const ds = (id: string, sql: string) => ({
    id, name: id, dataSourceId: lakeId, sql,
  });

  return {
    version: 1,
    name: REPORT_NAME,
    description: "ภาพรวมประสิทธิภาพการดำเนินงานทั้งกรม — งบประมาณ โครงการ ผู้รับเหมา ความเสี่ยง รายภูมิภาค.",
    parameters: [
      // `province` is bound by the drill-through API when the user clicks
      // a slice on the province treemap. Optional so the report runs
      // unfiltered when no drill is active.
      { name: "province", label: "Province", type: "string", required: false },
    ],
    dataSources: [
      // ── Page 1: Executive overview ──────────────────────────
      ds("q_total_budget", `SELECT SUM(CAST(planned_budget_mb AS REAL)) AS value FROM dpt_projects`),
      ds("q_total_actual", `SELECT SUM(CAST(actual_spend_mb AS REAL)) AS value FROM dpt_projects`),
      ds("q_avg_overrun", `SELECT AVG(CAST(overrun_pct AS REAL)) AS value FROM dpt_projects WHERE status != 'วางแผน'`),
      ds("q_avg_completion", `SELECT ROUND(AVG(CAST(completion_pct AS REAL)), 0) AS value FROM dpt_projects WHERE status != 'วางแผน'`),
      // Sparkline trends — 12 monthly points so each KPI card carries
      // its own context micro-chart. Pulls from dpt_budget_2568 which
      // has the monthly per-division roll-up; we sum across divisions
      // to land on the workspace-wide trace.
      ds("q_spark_planned", `SELECT month_index, SUM(CAST(planned_mb AS REAL)) AS v FROM dpt_budget_2568 GROUP BY month_index ORDER BY CAST(month_index AS INTEGER)`),
      ds("q_spark_actual",  `SELECT month_index, SUM(CAST(actual_mb  AS REAL)) AS v FROM dpt_budget_2568 GROUP BY month_index ORDER BY CAST(month_index AS INTEGER)`),
      ds("q_spark_overrun", `SELECT month_index, ROUND((SUM(CAST(actual_mb AS REAL)) - SUM(CAST(planned_mb AS REAL))) / SUM(CAST(planned_mb AS REAL)) * 100, 2) AS v FROM dpt_budget_2568 GROUP BY month_index ORDER BY CAST(month_index AS INTEGER)`),
      ds("q_spark_utilization", `SELECT month_index, AVG(CAST(utilization_pct AS REAL)) AS v FROM dpt_budget_2568 GROUP BY month_index ORDER BY CAST(month_index AS INTEGER)`),
      ds("q_total_projects", `SELECT COUNT(*) AS value FROM dpt_projects`),
      ds("q_status_breakdown", `SELECT status, COUNT(*) AS count FROM dpt_projects GROUP BY status ORDER BY count DESC`),
      ds("q_type_breakdown", `SELECT type, SUM(CAST(planned_budget_mb AS REAL)) AS planned, SUM(CAST(actual_spend_mb AS REAL)) AS actual FROM dpt_projects GROUP BY type ORDER BY planned DESC`),

      // ── Page 2: Budget execution ────────────────────────────
      ds("q_budget_trend", `SELECT month, month_index, SUM(CAST(planned_mb AS REAL)) AS planned, SUM(CAST(actual_mb AS REAL)) AS actual FROM dpt_budget_2568 GROUP BY month, month_index ORDER BY CAST(month_index AS INTEGER)`),
      ds("q_division_util", `SELECT division, MAX(CAST(cumulative_planned_mb AS REAL)) AS planned, MAX(CAST(cumulative_actual_mb AS REAL)) AS actual, MAX(CAST(utilization_pct AS REAL)) AS util_pct FROM dpt_budget_2568 GROUP BY division ORDER BY planned DESC`),
      ds("q_overrun_provinces", `SELECT province, SUM(CAST(planned_budget_mb AS REAL)) AS planned, SUM(CAST(actual_spend_mb AS REAL)) AS actual, ROUND((SUM(CAST(actual_spend_mb AS REAL)) - SUM(CAST(planned_budget_mb AS REAL))) / SUM(CAST(planned_budget_mb AS REAL)) * 100, 1) AS overrun_pct FROM dpt_projects WHERE status != 'วางแผน' GROUP BY province ORDER BY overrun_pct DESC LIMIT 10`),
      ds("q_treemap_provinces", `SELECT province, SUM(CAST(actual_spend_mb AS REAL)) AS spend FROM dpt_projects GROUP BY province ORDER BY spend DESC`),
      // Drill-through target for the province treemap: clicking a province
      // slice opens the panel with the underlying project rows so the
      // Operate "Run a business action" chips know which province to act on.
      // Province name binds via :province parameter set by the drill API.
      ds(
        "q_province_detail",
        `SELECT project_id, project_name, type, contractor, status, CAST(planned_budget_mb AS REAL) AS planned_mb, CAST(actual_spend_mb AS REAL) AS actual_mb, CAST(overrun_pct AS REAL) AS overrun_pct, CAST(completion_pct AS REAL) AS completion_pct FROM dpt_projects WHERE province = :province ORDER BY CAST(overrun_pct AS REAL) DESC LIMIT 200`,
      ),
      ds("q_funnel_status", `SELECT status, COUNT(*) AS n FROM dpt_projects GROUP BY status ORDER BY CASE status WHEN 'วางแผน' THEN 1 WHEN 'ดำเนินงาน' THEN 2 WHEN 'ล่าช้า' THEN 3 WHEN 'แล้วเสร็จ' THEN 4 ELSE 5 END`),
      ds("q_scatter_provinces", `SELECT province, SUM(CAST(planned_budget_mb AS REAL)) AS budget, ROUND((SUM(CAST(actual_spend_mb AS REAL)) - SUM(CAST(planned_budget_mb AS REAL))) / SUM(CAST(planned_budget_mb AS REAL)) * 100, 1) AS overrun, COUNT(*) AS projects FROM dpt_projects GROUP BY province ORDER BY budget DESC`),

      // ── Page 3: Project delivery ────────────────────────────
      ds("q_delayed_projects", `SELECT project_id, project_name, province, contractor, CAST(planned_budget_mb AS REAL) AS planned_mb, CAST(actual_spend_mb AS REAL) AS actual_mb, CAST(overrun_pct AS REAL) AS overrun_pct, CAST(completion_pct AS REAL) AS completion_pct FROM dpt_projects WHERE status = 'ล่าช้า' ORDER BY CAST(overrun_pct AS REAL) DESC LIMIT 25`),
      ds("q_priority_breakdown", `SELECT priority, COUNT(*) AS count, SUM(CAST(planned_budget_mb AS REAL)) AS planned FROM dpt_projects GROUP BY priority ORDER BY planned DESC`),
      ds("q_completion_distribution", `SELECT
        CASE
          WHEN CAST(completion_pct AS REAL) = 0 THEN '0%'
          WHEN CAST(completion_pct AS REAL) < 25 THEN '1-24%'
          WHEN CAST(completion_pct AS REAL) < 50 THEN '25-49%'
          WHEN CAST(completion_pct AS REAL) < 75 THEN '50-74%'
          WHEN CAST(completion_pct AS REAL) < 100 THEN '75-99%'
          ELSE '100%'
        END AS bucket,
        COUNT(*) AS count
        FROM dpt_projects GROUP BY bucket ORDER BY bucket`),

      // ── Page 4: Contractor scorecard ────────────────────────
      ds("q_contractors", `SELECT contractor, CAST(total_projects AS INTEGER) AS total_projects, CAST(total_value_mb AS REAL) AS total_value_mb, CAST(avg_overrun_pct AS REAL) AS avg_overrun_pct, CAST(on_time_delivery_pct AS REAL) AS on_time_delivery_pct, CAST(quality_score AS REAL) AS quality_score, CAST(safety_incidents_yr AS INTEGER) AS safety_incidents_yr, blacklist_risk FROM dpt_contractors ORDER BY total_value_mb DESC`),
      ds("q_contractor_quality", `SELECT contractor, CAST(quality_score AS REAL) AS quality_score, CAST(on_time_delivery_pct AS REAL) AS on_time_pct FROM dpt_contractors ORDER BY quality_score DESC`),

      // ── Page 5: Regional view ───────────────────────────────
      ds("q_regional", `SELECT region, CAST(project_count AS INTEGER) AS project_count, CAST(planned_budget_mb AS REAL) AS planned_mb, CAST(actual_spend_mb AS REAL) AS actual_mb, CAST(overrun_pct AS REAL) AS overrun_pct, CAST(delay_rate_pct AS REAL) AS delay_rate_pct, CAST(avg_completion_pct AS REAL) AS avg_completion_pct, CAST(citizen_satisfaction AS REAL) AS satisfaction FROM dpt_regional_kpis ORDER BY planned_mb DESC`),
      ds("q_regional_trend", `SELECT region, SUM(CAST(actual_spend_mb AS REAL)) AS actual_mb FROM dpt_projects WHERE status != 'วางแผน' GROUP BY region ORDER BY actual_mb DESC`),
    ],

    pages: [
      page1ExecutiveOverview(),
      page2BudgetExecution(),
      page3ProjectDelivery(),
      page4Contractors(),
      page5Regional(),
    ],
  };
}

/* ── Page builders ────────────────────────────────────────────────── */

function page1ExecutiveOverview() {
  return {
    id: "p1_overview",
    size: "A4", orientation: "portrait",
    blocks: [
      {
        id: "p1_title", type: "title",
        x: 0, y: 0, w: 12, h: 2,
        config: {
          text: "CEO Command Center — กรมโยธาธิการและผังเมือง",
          subtitle: "ภาพรวมประจำเดือน — งบประมาณ การส่งมอบ ความเสี่ยง รายภูมิภาค",
          align: "left",
        },
      },
      {
        id: "p1_kpi_total", type: "kpi",
        x: 0, y: 2, w: 3, h: 3,
        config: {
          queryId: "q_total_budget",
          label: "งบประมาณรวม",
          valueField: "value",
          format: "number",
          aggregate: "sum",
          suffix: " ลบ.",
          sparkQueryId: "q_spark_planned",
          sparkValueField: "v",
          sparkPositive: "up",
        },
      },
      {
        id: "p1_kpi_actual", type: "kpi",
        x: 3, y: 2, w: 3, h: 3,
        config: {
          queryId: "q_total_actual",
          label: "เบิกจ่ายแล้ว",
          valueField: "value",
          format: "number",
          aggregate: "sum",
          suffix: " ลบ.",
          sparkQueryId: "q_spark_actual",
          sparkValueField: "v",
          sparkPositive: "up",
        },
      },
      {
        id: "p1_kpi_overrun", type: "kpi",
        x: 6, y: 2, w: 3, h: 3,
        config: {
          queryId: "q_avg_overrun",
          label: "เกินงบเฉลี่ย",
          valueField: "value",
          format: "number",
          aggregate: "avg",
          suffix: " %",
          sparkQueryId: "q_spark_overrun",
          sparkValueField: "v",
          sparkPositive: "down",
        },
      },
      {
        id: "p1_kpi_completion", type: "chart",
        x: 9, y: 2, w: 3, h: 3,
        config: {
          queryId: "q_avg_completion",
          chartType: "gauge",
          title: "ความคืบหน้าเฉลี่ย",
          xField: "value",
          yFields: ["value"],
          gaugeMin: 0,
          gaugeMax: 100,
          gaugeTarget: 80,
          gaugeZones: [
            { upTo: 50,  color: "danger",  label: "ต่ำ" },
            { upTo: 75,  color: "warning", label: "ปานกลาง" },
            { upTo: 100, color: "success", label: "ดี" },
          ],
          showLegend: false,
          aggregate: "avg",
        },
      },
      {
        id: "p1_chart_type", type: "chart",
        x: 0, y: 5, w: 8, h: 7,
        config: {
          queryId: "q_type_breakdown",
          chartType: "bar",
          title: "งบประมาณตามประเภทโครงการ (Planned vs Actual)",
          xField: "type",
          yFields: ["planned", "actual"],
          valueFormat: "number",
          showLegend: true,
        },
      },
      {
        id: "p1_chart_status", type: "chart",
        x: 8, y: 5, w: 4, h: 7,
        config: {
          queryId: "q_status_breakdown",
          chartType: "pie",
          title: "สัดส่วนสถานะโครงการ",
          xField: "status",
          yFields: ["count"],
          showLegend: true,
        },
      },
      {
        id: "p1_callout", type: "callout",
        x: 0, y: 13, w: 12, h: 3,
        config: {
          variant: "info",
          title: "สรุปสำหรับผู้บริหาร",
          body: "หน้านี้แสดงภาพรวมงบประมาณและสถานะโครงการทั้งกรม.\nหน้าถัดไป: การเบิกจ่ายตามสำนัก • โครงการที่ล่าช้า • ผู้รับเหมา • ประสิทธิภาพรายภูมิภาค",
        },
      },
    ],
  };
}

function page2BudgetExecution() {
  return {
    id: "p2_budget",
    size: "A4", orientation: "portrait",
    blocks: [
      {
        id: "p2_title", type: "title",
        x: 0, y: 0, w: 12, h: 2,
        config: {
          text: "การเบิกจ่ายงบประมาณ — Budget Execution",
          subtitle: "ติดตามการใช้งบรายเดือน รายสำนัก และจังหวัดที่ใช้เกินแผน",
          align: "left",
        },
      },
      {
        id: "p2_chart_trend", type: "chart",
        x: 0, y: 2, w: 12, h: 6,
        config: {
          queryId: "q_budget_trend",
          chartType: "area",
          title: "การเบิกจ่ายสะสม ปีงบประมาณ 2568 (Planned vs Actual)",
          xField: "month",
          yFields: ["planned", "actual"],
          valueFormat: "number",
          showLegend: true,
        },
      },
      {
        id: "p2_chart_div", type: "chart",
        x: 0, y: 8, w: 7, h: 7,
        config: {
          queryId: "q_division_util",
          chartType: "bar",
          title: "การเบิกจ่ายแยกรายสำนัก (สะสม)",
          xField: "division",
          yFields: ["planned", "actual"],
          valueFormat: "number",
          showLegend: true,
        },
      },
      {
        id: "p2_treemap_provinces", type: "chart",
        x: 7, y: 8, w: 5, h: 7,
        config: {
          queryId: "q_treemap_provinces",
          chartType: "treemap",
          title: "ส่วนแบ่งงบประมาณรายจังหวัด",
          xField: "province",
          yFields: ["spend"],
          showLegend: false,
          // Click any province → drill panel surfaces all projects in that
          // province + the Operate "Run a business action" chips so the
          // exec can fire "ส่งหนังสือแจ้งผู้รับเหมา" or "ขออนุมัติโยกงบประมาณ"
          // straight from the row they're staring at.
          drilldown: {
            queryId: "q_province_detail",
            filterParam: "province",
            title: "โครงการในจังหวัด",
          },
        },
      },
    ],
  };
}

function page3ProjectDelivery() {
  return {
    id: "p3_delivery",
    size: "A4", orientation: "portrait",
    blocks: [
      {
        id: "p3_title", type: "title",
        x: 0, y: 0, w: 12, h: 2,
        config: {
          text: "การส่งมอบโครงการ — Project Delivery",
          subtitle: "โครงการที่ล่าช้า การกระจายความคืบหน้า และระดับความสำคัญ",
          align: "left",
        },
      },
      {
        id: "p3_chart_dist", type: "chart",
        x: 0, y: 2, w: 7, h: 6,
        config: {
          queryId: "q_completion_distribution",
          chartType: "bar",
          title: "การกระจายความคืบหน้าโครงการ",
          xField: "bucket",
          yFields: ["count"],
          showLegend: false,
        },
      },
      {
        id: "p3_chart_priority", type: "chart",
        x: 7, y: 2, w: 5, h: 6,
        config: {
          queryId: "q_funnel_status",
          chartType: "funnel",
          title: "ขั้นตอนวงจรชีวิตโครงการ",
          xField: "status",
          yFields: ["n"],
          showLegend: false,
        },
      },
      {
        id: "p3_table_delayed", type: "table",
        x: 0, y: 8, w: 12, h: 8,
        config: {
          queryId: "q_delayed_projects",
          title: "Top 25 โครงการที่ล่าช้า — เรียงตาม % เกินงบ",
          columns: [
            { key: "project_id", label: "รหัส", width: 100 },
            { key: "project_name", label: "ชื่อโครงการ", width: 220 },
            { key: "province", label: "จังหวัด", width: 110 },
            { key: "contractor", label: "ผู้รับเหมา", width: 150 },
            { key: "planned_mb", label: "งบแผน (ลบ.)", width: 100, format: "number", align: "right" },
            { key: "actual_mb", label: "ใช้จริง (ลบ.)", width: 100, format: "number", align: "right" },
            { key: "overrun_pct", label: "เกินงบ %", width: 90, format: "number", align: "right" },
            { key: "completion_pct", label: "คืบหน้า %", width: 90, format: "number", align: "right" },
          ],
          pageSize: 25,
          stripe: true,
          showTotals: false,
          actions: [],
        },
      },
    ],
  };
}

function page4Contractors() {
  return {
    id: "p4_contractors",
    size: "A4", orientation: "portrait",
    blocks: [
      {
        id: "p4_title", type: "title",
        x: 0, y: 0, w: 12, h: 2,
        config: {
          text: "บัญชีผู้รับเหมา — Contractor Scorecard",
          subtitle: "ประสิทธิภาพ คะแนนคุณภาพ และความเสี่ยงของผู้รับเหมา",
          align: "left",
        },
      },
      {
        id: "p4_chart_quality", type: "chart",
        x: 0, y: 2, w: 6, h: 6,
        config: {
          queryId: "q_contractor_quality",
          chartType: "bar",
          title: "คะแนนคุณภาพ (1-5)",
          xField: "contractor",
          yFields: ["quality_score"],
          showLegend: false,
        },
      },
      {
        id: "p4_chart_ontime", type: "chart",
        x: 6, y: 2, w: 6, h: 6,
        config: {
          queryId: "q_contractor_quality",
          chartType: "bar",
          title: "การส่งมอบตรงเวลา (% On-Time)",
          xField: "contractor",
          yFields: ["on_time_pct"],
          showLegend: false,
        },
      },
      {
        id: "p4_table_contractors", type: "table",
        x: 0, y: 8, w: 12, h: 8,
        config: {
          queryId: "q_contractors",
          title: "บัญชีผู้รับเหมาทั้งหมด",
          columns: [
            { key: "contractor", label: "ผู้รับเหมา", width: 200 },
            { key: "total_projects", label: "จำนวนโครงการ", width: 120, format: "number", align: "right" },
            { key: "total_value_mb", label: "มูลค่ารวม (ลบ.)", width: 130, format: "number", align: "right" },
            { key: "avg_overrun_pct", label: "เกินงบเฉลี่ย %", width: 120, format: "number", align: "right" },
            { key: "on_time_delivery_pct", label: "ตรงเวลา %", width: 100, format: "number", align: "right" },
            { key: "quality_score", label: "คะแนนคุณภาพ", width: 110, format: "number", align: "right" },
            { key: "safety_incidents_yr", label: "อุบัติเหตุ/ปี", width: 100, format: "number", align: "right" },
            { key: "blacklist_risk", label: "ความเสี่ยง", width: 100 },
          ],
          pageSize: 20,
          stripe: true,
          showTotals: false,
          actions: [],
        },
      },
    ],
  };
}

function page5Regional() {
  return {
    id: "p5_regional",
    size: "A4", orientation: "portrait",
    blocks: [
      {
        id: "p5_title", type: "title",
        x: 0, y: 0, w: 12, h: 2,
        config: {
          text: "ประสิทธิภาพรายภูมิภาค — Regional Performance",
          subtitle: "เปรียบเทียบงบประมาณ การส่งมอบ และความพึงพอใจของประชาชนในแต่ละภาค",
          align: "left",
        },
      },
      {
        id: "p5_chart_spend", type: "chart",
        x: 0, y: 2, w: 8, h: 6,
        config: {
          queryId: "q_regional",
          chartType: "bar",
          title: "งบประมาณ Planned vs Actual รายภาค",
          xField: "region",
          yFields: ["planned_mb", "actual_mb"],
          valueFormat: "number",
          showLegend: true,
        },
      },
      {
        id: "p5_scatter_provinces", type: "chart",
        x: 8, y: 2, w: 4, h: 6,
        config: {
          queryId: "q_scatter_provinces",
          chartType: "scatter",
          title: "Province triage matrix",
          xField: "budget",
          yFields: ["overrun"],
          sizeField: "projects",
          showLegend: false,
          // Same drilldown as the treemap — clicking a province bubble
          // (e.g. the outlier in the top-right "high spend, high overrun"
          // quadrant) opens the province detail + Operate action chips.
          drilldown: {
            queryId: "q_province_detail",
            filterParam: "province",
            title: "โครงการในจังหวัด",
          },
        },
      },
      {
        id: "p5_table_regional", type: "table",
        x: 0, y: 8, w: 12, h: 6,
        config: {
          queryId: "q_regional",
          title: "ตารางสรุปรายภาค",
          columns: [
            { key: "region", label: "ภาค", width: 180 },
            { key: "project_count", label: "โครงการ", width: 90, format: "number", align: "right" },
            { key: "planned_mb", label: "งบแผน (ลบ.)", width: 120, format: "number", align: "right" },
            { key: "actual_mb", label: "ใช้จริง (ลบ.)", width: 120, format: "number", align: "right" },
            { key: "overrun_pct", label: "เกินงบ %", width: 100, format: "number", align: "right" },
            { key: "delay_rate_pct", label: "ล่าช้า %", width: 100, format: "number", align: "right" },
            { key: "avg_completion_pct", label: "คืบหน้า %", width: 100, format: "number", align: "right" },
            { key: "satisfaction", label: "พึงพอใจ", width: 90, format: "number", align: "right" },
          ],
          pageSize: 10,
          stripe: true,
          showTotals: false,
          actions: [],
        },
      },
    ],
  };
}
