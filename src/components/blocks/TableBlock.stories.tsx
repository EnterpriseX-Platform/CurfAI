/**
 * TableBlock visual-regression stories — Curf (Harness 8).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { TableBlock } from "./TableBlock";
import type { Block, Report } from "@/lib/reporting/schema";

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook Table",
  pages: [],
  dataSources: [{ id: "deals", kind: "static" as const, rows: [] }],
} as unknown as Report;

const ROWS = [
  { region: "North America", deals: 42, revenue: 812_000, winRate: 0.31 },
  { region: "EMEA", deals: 27, revenue: 505_500, winRate: 0.24 },
  { region: "APAC", deals: 15, revenue: 240_000, winRate: 0.19 },
  { region: "LATAM", deals: 8, revenue: 96_000, winRate: 0.15 },
];

const baseBlock: Block = {
  id: "table-1",
  type: "table",
  x: 0, y: 0, w: 8, h: 6,
  config: {
    queryId: "deals",
    title: "Deals by region",
    columns: [
      { key: "region", label: "Region", type: "string", total: "none" },
      { key: "deals", label: "Deals", type: "number", align: "right", total: "sum" },
      { key: "revenue", label: "Revenue", type: "currency", align: "right", total: "sum" },
      { key: "winRate", label: "Win rate", type: "percent", align: "right", total: "avg" },
    ],
    pageSize: 50,
    stripe: true,
    showTotals: true,
    actions: [],
  },
};

const meta: Meta<typeof TableBlock> = {
  title: "Blocks/TableBlock",
  component: TableBlock,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof TableBlock>;

/** Striped rows, mixed column types, totals row — the common shape. */
export const Default: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: { deals: ROWS }, params: {} },
};

/** Stripe disabled + totals hidden. */
export const PlainNoTotals: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, stripe: false, showTotals: false } } as Block,
    report: REPORT_STUB, dataset: { deals: ROWS }, params: {},
  },
};

/** Formula column — verifies a spreadsheet-style computed column renders. */
export const WithFormulaColumn: Story = {
  args: {
    block: {
      ...baseBlock,
      config: {
        ...baseBlock.config,
        columns: [
          ...baseBlock.config.columns,
          { key: "avgDealSize", label: "Avg deal size", type: "formula", align: "right", total: "none", formula: "=revenue / deals", formulaFormat: "currency" },
        ],
      },
    } as Block,
    report: REPORT_STUB, dataset: { deals: ROWS }, params: {},
  },
};

/** Empty dataset — verifies the table renders headers with no rows rather than crashing. */
export const Empty: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: { deals: [] }, params: {} },
};
