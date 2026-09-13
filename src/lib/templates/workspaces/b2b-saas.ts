/**
 * B2B SaaS workspace template.
 *
 *   const template = b2bSaasTemplate();
 *   await applyWorkspaceTemplate(tenantId, template);
 *
 * Generates:
 *   - 4 lake tables: users, subscriptions, events, mrr_snapshots
 *   - 1 report: "MRR & growth overview" (KPI + line + table)
 *   - 1 watcher: "MRR drop alert"
 *
 * Sample data is generated synthetically — 100 users with realistic
 * signup spread, monthly MRR snapshots over the last 6 months, ~30
 * days of pageview/login events. No PII; safe to use as a public demo.
 *
 * Why a single comprehensive template instead of multiple thin ones?
 * The point of the template is "30 seconds from empty workspace to
 * working dashboard" — that means rich, opinionated, complete. A
 * customer who wants a different shape can fork and edit.
 */

export type WorkspaceTemplate = {
  id: string;
  name: string;
  description: string;
  /** Lake tables created by the template. The applier writes them via
   *  the standard createOrReplaceTable path. */
  tables: Array<{
    name: string;
    rows: Array<Record<string, unknown>>;
    description?: string;
  }>;
  /** Reports created via prisma.report.create with the rendered definition. */
  reports: Array<{
    name: string;
    description: string;
    /** Caller resolves the lake DataSource id and threads it through. */
    buildDefinition: (lakeDataSourceId: string) => any;
  }>;
  /** Watchers wired to a report; report id is resolved post-create by name. */
  watchers: Array<{
    name: string;
    reportName: string;
    cron: string;
    config: Record<string, unknown>;
  }>;
  /** Materialized views — recomputed on cron, materialised back into the lake. */
  materializedViews: Array<{
    name: string;
    sql: string;
    cron: string;
    description?: string;
  }>;
};

export function b2bSaasTemplate(): WorkspaceTemplate {
  return {
    id: "b2b-saas",
    name: "B2B SaaS",
    description: "MRR, churn, signups, product engagement — populated with 6 months of synthetic data.",
    tables: buildTables(),
    reports: [
      {
        name: "MRR & growth overview",
        description: "Top-line KPIs: total MRR, active subscriptions, churn rate, plus a 6-month MRR trend.",
        buildDefinition: (lakeDataSourceId: string) => ({
          version: 1,
          name: "MRR & growth overview",
          description: "Auto-populated from the B2B SaaS workspace template.",
          parameters: [],
          // Lake stores every column as TEXT (see lib/lake/tables.ts header
          // comment for why). Numeric blocks need actual numbers, so we
          // CAST AS REAL in the queries — otherwise the chart's xField/
          // yField bindings see strings and the area chart degenerates
          // to a single tall bar at the left edge.
          dataSources: [
            {
              id: "q_total_mrr",
              name: "Total MRR (latest snapshot)",
              dataSourceId: lakeDataSourceId,
              sql: `SELECT CAST(total_mrr AS REAL) AS value FROM mrr_snapshots ORDER BY snapshot_date DESC LIMIT 1`,
            },
            {
              id: "q_active_subs",
              name: "Active subscriptions",
              dataSourceId: lakeDataSourceId,
              sql: `SELECT COUNT(*) AS value FROM subscriptions WHERE status = 'active'`,
            },
            {
              id: "q_churn_rate",
              name: "Churn rate (last 30d)",
              dataSourceId: lakeDataSourceId,
              sql: `SELECT
                CAST((SELECT COUNT(*) FROM subscriptions WHERE status = 'churned' AND churned_at > date('now', '-30 day')) AS REAL) /
                NULLIF((SELECT COUNT(*) FROM subscriptions WHERE created_at < date('now', '-30 day')), 0) AS value`,
            },
            {
              id: "q_mrr_trend",
              name: "MRR over time",
              dataSourceId: lakeDataSourceId,
              sql: `SELECT snapshot_date, CAST(total_mrr AS REAL) AS total_mrr FROM mrr_snapshots ORDER BY snapshot_date ASC`,
            },
            {
              id: "q_top_plans",
              name: "Top plans",
              dataSourceId: lakeDataSourceId,
              sql: `SELECT plan, COUNT(*) AS subscribers, SUM(CAST(monthly_amount AS REAL)) AS mrr
                    FROM subscriptions WHERE status = 'active'
                    GROUP BY plan ORDER BY mrr DESC`,
            },
          ],
          // Layout: 12-column grid. Title spans full width; the three KPIs
          // sit on row 1 (4 cols each); the chart spans full width on row 2;
          // the plans table closes on row 3.
          pages: [
            {
              id: "p1",
              size: "A4",
              orientation: "portrait",
              blocks: [
                {
                  id: "b_title", type: "title",
                  x: 0, y: 0, w: 12, h: 2,
                  config: { text: "MRR & growth overview", subtitle: "Auto-generated from the B2B SaaS workspace template", align: "left" },
                },
                {
                  id: "b_kpi_mrr", type: "kpi",
                  x: 0, y: 2, w: 4, h: 3,
                  config: {
                    queryId: "q_total_mrr",
                    label: "Monthly recurring revenue",
                    valueField: "value",
                    format: "currency",
                    aggregate: "sum",
                  },
                },
                {
                  id: "b_kpi_active", type: "kpi",
                  x: 4, y: 2, w: 4, h: 3,
                  config: {
                    queryId: "q_active_subs",
                    label: "Active subscriptions",
                    valueField: "value",
                    format: "number",
                    aggregate: "sum",
                  },
                },
                {
                  id: "b_kpi_churn", type: "kpi",
                  x: 8, y: 2, w: 4, h: 3,
                  config: {
                    queryId: "q_churn_rate",
                    label: "30-day churn rate",
                    valueField: "value",
                    format: "percent",
                    aggregate: "avg",
                  },
                },
                {
                  id: "b_chart_mrr", type: "chart",
                  x: 0, y: 5, w: 12, h: 8,
                  config: {
                    queryId: "q_mrr_trend",
                    chartType: "area",
                    title: "MRR over the last 6 months",
                    xField: "snapshot_date",
                    yFields: ["total_mrr"],
                    valueFormat: "currency",
                    showLegend: false,
                  },
                },
                {
                  id: "b_table_plans", type: "table",
                  x: 0, y: 13, w: 12, h: 6,
                  config: {
                    queryId: "q_top_plans",
                    title: "Active subscriptions by plan",
                    columns: [
                      { key: "plan", label: "Plan", type: "string", total: "none" },
                      { key: "subscribers", label: "Subscribers", type: "number", total: "sum" },
                      { key: "mrr", label: "MRR", type: "currency", total: "sum" },
                    ],
                    pageSize: 10,
                    stripe: true,
                    showTotals: true,
                    actions: [],
                  },
                },
              ],
            },
          ],
        }),
      },
    ],
    watchers: [
      {
        name: "MRR drop alert",
        reportName: "MRR & growth overview",
        cron: "0 9 * * 1-5", // 9am weekdays
        config: {
          blockId: "b_kpi_mrr",
          thresholdPct: 5,
          destination: "log",
        },
      },
    ],
    materializedViews: [
      {
        name: "weekly_signups",
        cron: "0 6 * * 1", // Monday 6am
        description: "Pre-aggregated weekly signup counts; powers the morning Brief.",
        sql: `SELECT
                strftime('%Y-W%W', created_at) AS week,
                COUNT(*) AS signups
              FROM users
              GROUP BY week
              ORDER BY week DESC
              LIMIT 26`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Synthetic data generators
// ---------------------------------------------------------------------------

const PLANS = [
  { name: "starter", price: 49 },
  { name: "team", price: 199 },
  { name: "business", price: 499 },
  { name: "enterprise", price: 1499 },
];
const SOURCES = ["organic", "paid_search", "referral", "outbound", "content"];
const REGIONS = ["Americas", "EMEA", "APAC"];
const EVENTS = ["login", "viewed_dashboard", "ran_report", "exported_pdf", "invited_user", "upgraded_plan", "viewed_pricing"];

function buildTables(): WorkspaceTemplate["tables"] {
  // Use a deterministic PRNG so re-applying the template produces the
  // same rows. Mulberry32 is small + good-enough.
  const rng = mulberry32(0x4c7f3a91);

  // Stable "today" so generated dates are repeatable across runs. Real
  // workspace data won't care, but lining everything up to a consistent
  // date makes the demo look intentional.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const users: Array<Record<string, unknown>> = [];
  const userCount = 120;
  for (let i = 0; i < userCount; i++) {
    const daysAgo = Math.floor(rng() * 180); // last 6 months
    const createdAt = new Date(today.getTime() - daysAgo * 86400000);
    const region = REGIONS[Math.floor(rng() * REGIONS.length)];
    const source = SOURCES[Math.floor(rng() * SOURCES.length)];
    users.push({
      user_id: `u_${String(i + 1).padStart(4, "0")}`,
      email: `user${i + 1}@example.com`,
      created_at: isoDate(createdAt),
      region,
      acquisition_source: source,
      company_size: pick(rng, ["1-10", "11-50", "51-200", "201-1000", "1000+"]),
    });
  }

  // Each user gets a subscription. ~85% active, ~15% churned.
  const subscriptions: Array<Record<string, unknown>> = users.map((u, i) => {
    const plan = PLANS[Math.floor(rng() * PLANS.length)];
    const isChurned = rng() < 0.15;
    const subStart = new Date((u.created_at as string) + "T00:00:00Z");
    const churnedAt = isChurned
      ? new Date(subStart.getTime() + (30 + Math.floor(rng() * 120)) * 86400000)
      : null;
    return {
      subscription_id: `s_${String(i + 1).padStart(4, "0")}`,
      user_id: u.user_id,
      plan: plan.name,
      monthly_amount: plan.price,
      status: isChurned ? "churned" : "active",
      created_at: u.created_at,
      churned_at: churnedAt && churnedAt < today ? isoDate(churnedAt) : null,
    };
  });

  // 30 days of events — each user produces 0-15 events per period.
  const events: Array<Record<string, unknown>> = [];
  const days = 30;
  for (let d = 0; d < days; d++) {
    const dayStart = new Date(today.getTime() - d * 86400000);
    for (const u of users.slice(0, Math.floor(userCount * 0.7))) {
      const count = Math.floor(rng() * 4);
      for (let k = 0; k < count; k++) {
        const eventTime = new Date(dayStart.getTime() + Math.floor(rng() * 86400000));
        events.push({
          event_id: `e_${events.length + 1}`,
          user_id: u.user_id,
          event_name: pick(rng, EVENTS),
          event_at: isoDateTime(eventTime),
        });
      }
    }
  }

  // Monthly MRR snapshots — last 6 months, growing trend with some noise.
  const mrrSnapshots: Array<Record<string, unknown>> = [];
  for (let m = 5; m >= 0; m--) {
    const snapDate = new Date(today.getTime() - m * 30 * 86400000);
    // Growth: +12% per month from a $35k base, +-5% noise.
    const base = 35000 * Math.pow(1.12, 5 - m);
    const noise = (rng() - 0.5) * 0.1 * base;
    mrrSnapshots.push({
      snapshot_date: isoDate(snapDate),
      total_mrr: Math.round(base + noise),
      active_subscriptions: subscriptions.filter((s) => {
        const c = s.created_at as string;
        return c <= isoDate(snapDate) && (!s.churned_at || (s.churned_at as string) > isoDate(snapDate));
      }).length,
    });
  }

  return [
    { name: "users", rows: users, description: "Synthetic 120-user table — region + acquisition source + company size." },
    { name: "subscriptions", rows: subscriptions, description: "One subscription per user; ~15% churned." },
    { name: "events", rows: events, description: "Last 30 days of product activity — login, viewed_dashboard, ran_report, etc." },
    { name: "mrr_snapshots", rows: mrrSnapshots, description: "Monthly MRR rollups over the last 6 months." },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}
