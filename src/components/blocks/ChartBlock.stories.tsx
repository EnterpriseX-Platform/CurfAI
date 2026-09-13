/**
 * ChartBlock visual-regression stories — Curf (Harness 8).
 *
 * Snapshots cover bar / line / area / pie / waterfall / gauge / bullet so a
 * CSS regression to the recharts wrapper or the palette resolution shows
 * up as a diff.
 *
 * Roadmap follow-up: extend to combo, treemap, funnel, scatter once those
 * have stable visual references.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ChartBlock } from "./ChartBlock";
import type { Block, Report } from "@/lib/reporting/schema";

// ChartBlock's root is `h-full` -> recharts' <ResponsiveContainer
// height="100%">, which needs a real pixel height somewhere up the
// ancestor chain. The designer/viewer grid provides that; Storybook's
// plain padded decorator doesn't, so every chart silently rendered at
// 0 height (title only, no chart) until this wrapper gave it one.
const CHART_HEIGHT = 360;

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook chart",
  pages: [],
  dataSources: [{ id: "monthly", kind: "static" as const, rows: [] }],
} as unknown as Report;

const SAMPLE_ROWS = [
  { month: "Jan", revenue: 110_000, cost: 60_000 },
  { month: "Feb", revenue: 132_000, cost: 71_000 },
  { month: "Mar", revenue: 158_000, cost: 80_000 },
  { month: "Apr", revenue: 145_000, cost: 78_000 },
  { month: "May", revenue: 172_000, cost: 84_000 },
  { month: "Jun", revenue: 198_000, cost: 92_000 },
];

function chartBlock(chartType: "bar" | "line" | "area" | "pie"): Block {
  return {
    id: `chart-${chartType}`,
    type: "chart",
    x: 0, y: 0, w: 6, h: 4,
    config: {
      queryId: "monthly",
      chartType,
      title: `${chartType[0].toUpperCase()}${chartType.slice(1)} demo`,
      xField: "month",
      yFields: chartType === "pie" ? ["revenue"] : ["revenue", "cost"],
    },
  } as Block;
}

const meta: Meta<typeof ChartBlock> = {
  title: "Blocks/ChartBlock",
  component: ChartBlock,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div style={{ height: CHART_HEIGHT }}><Story /></div>],
};
export default meta;

type Story = StoryObj<typeof ChartBlock>;

export const Bar: Story = {
  args: {
    block: chartBlock("bar"),
    report: REPORT_STUB,
    dataset: { monthly: SAMPLE_ROWS },
    params: {},
  },
};

export const Line: Story = {
  args: {
    block: chartBlock("line"),
    report: REPORT_STUB,
    dataset: { monthly: SAMPLE_ROWS },
    params: {},
  },
};

export const Area: Story = {
  args: {
    block: chartBlock("area"),
    report: REPORT_STUB,
    dataset: { monthly: SAMPLE_ROWS },
    params: {},
  },
};

export const Pie: Story = {
  args: {
    block: chartBlock("pie"),
    report: REPORT_STUB,
    dataset: { monthly: SAMPLE_ROWS },
    params: {},
  },
};

/** Empty dataset — verifies graceful fallback. */
export const Empty: Story = {
  args: {
    block: chartBlock("bar"),
    report: REPORT_STUB,
    dataset: { monthly: [] },
    params: {},
  },
};

// ---------------------------------------------------------------------------
// Tier 2 chart types (gated behind viz.chart.* at save time — the pure
// renderer itself doesn't feature-gate, so these render regardless of tier).

const WATERFALL_ROWS = [
  { stage: "Starting ARR", delta: 1_200_000 },
  { stage: "New business", delta: 340_000 },
  { stage: "Expansion", delta: 180_000 },
  { stage: "Churn", delta: -95_000 },
  { stage: "Contraction", delta: -40_000 },
  { stage: "Ending ARR", delta: 1_585_000 },
];

/** Bridge chart for ARR movement — mixed positive/negative deltas + a running total. */
export const Waterfall: Story = {
  args: {
    block: {
      id: "chart-waterfall",
      type: "chart",
      x: 0, y: 0, w: 6, h: 4,
      config: {
        queryId: "monthly",
        chartType: "waterfall",
        title: "ARR bridge",
        xField: "stage",
        yFields: ["delta"],
      },
    } as Block,
    report: REPORT_STUB,
    dataset: { monthly: WATERFALL_ROWS },
    params: {},
  },
};

/** Radial gauge — value 72 against a 0-100 range, target at 80, 3-zone band. */
export const Gauge: Story = {
  args: {
    block: {
      id: "chart-gauge",
      type: "chart",
      x: 0, y: 0, w: 4, h: 4,
      config: {
        queryId: "monthly",
        chartType: "gauge",
        title: "CSAT score",
        xField: "metric",
        yFields: ["value"],
        gaugeMin: 0,
        gaugeMax: 100,
        gaugeTarget: 80,
        gaugeZones: [
          { upTo: 50, color: "danger" },
          { upTo: 80, color: "warning" },
          { upTo: 100, color: "success" },
        ],
      },
    } as Block,
    report: REPORT_STUB,
    dataset: { monthly: [{ metric: "CSAT", value: 72 }] },
    params: {},
  },
};

/** Bullet chart — compact KPI-vs-target with the same qualitative bands as Gauge. */
export const Bullet: Story = {
  args: {
    block: {
      id: "chart-bullet",
      type: "chart",
      x: 0, y: 0, w: 6, h: 2,
      config: {
        queryId: "monthly",
        chartType: "bullet",
        title: "Pipeline coverage",
        xField: "metric",
        yFields: ["value"],
        gaugeMin: 0,
        gaugeMax: 100,
        gaugeTarget: 80,
        gaugeZones: [
          { upTo: 50, color: "danger" },
          { upTo: 80, color: "warning" },
          { upTo: 100, color: "success" },
        ],
      },
    } as Block,
    report: REPORT_STUB,
    dataset: { monthly: [{ metric: "Coverage", value: 64 }] },
    params: {},
  },
};
