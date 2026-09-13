/**
 * PivotBlock visual-regression stories — Curf (Harness 8).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { PivotBlock } from "./PivotBlock";
import type { Block, Report } from "@/lib/reporting/schema";

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook Pivot",
  pages: [],
  dataSources: [{ id: "sales", kind: "static" as const, rows: [] }],
} as unknown as Report;

const ROWS = [
  { region: "North America", quarter: "Q1", revenue: 210_000 },
  { region: "North America", quarter: "Q2", revenue: 245_000 },
  { region: "EMEA", quarter: "Q1", revenue: 130_000 },
  { region: "EMEA", quarter: "Q2", revenue: 158_000 },
  { region: "APAC", quarter: "Q1", revenue: 88_000 },
  { region: "APAC", quarter: "Q2", revenue: 101_000 },
];

const baseBlock: Block = {
  id: "pivot-1",
  type: "pivot",
  x: 0, y: 0, w: 8, h: 6,
  config: {
    queryId: "sales",
    title: "Revenue by region and quarter",
    rowField: "region",
    colField: "quarter",
    valueField: "revenue",
    aggregation: "sum",
    format: "currency",
    showRowTotals: true,
    showColTotals: true,
    heatmap: true,
  },
};

const meta: Meta<typeof PivotBlock> = {
  title: "Blocks/PivotBlock",
  component: PivotBlock,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof PivotBlock>;

/** Sum aggregation, currency format, heatmap shading + row/col totals. */
export const Default: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: { sales: ROWS }, params: {} },
};

/** Heatmap shading disabled — plain totals table. */
export const NoHeatmapShading: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, heatmap: false } } as Block,
    report: REPORT_STUB, dataset: { sales: ROWS }, params: {},
  },
};

/** Count aggregation, number format — a different measure shape. */
export const CountAggregation: Story = {
  args: {
    block: {
      ...baseBlock,
      config: { ...baseBlock.config, title: "Deal count by region and quarter", aggregation: "count", format: "number" },
    } as Block,
    report: REPORT_STUB, dataset: { sales: ROWS }, params: {},
  },
};

/** Empty dataset — renders BlockEmptyState instead of a table. */
export const Empty: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: { sales: [] }, params: {} },
};
