/**
 * CohortRetentionBlock visual-regression stories — Curf (Harness 8).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { CohortRetentionBlock } from "./CohortRetentionBlock";
import type { Block, Report } from "@/lib/reporting/schema";

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook Cohort Retention",
  pages: [],
  dataSources: [{ id: "signups", kind: "static" as const, rows: [] }],
} as unknown as Report;

// Triangular shape: a cohort N periods old only has data through period N.
const COHORTS = [
  { cohort: "2026-01", size: 420, retention: [1.0, 0.62, 0.48, 0.4, 0.35] },
  { cohort: "2026-02", size: 505, retention: [1.0, 0.58, 0.44, 0.37] },
  { cohort: "2026-03", size: 470, retention: [1.0, 0.6, 0.46] },
  { cohort: "2026-04", size: 610, retention: [1.0, 0.65] },
  { cohort: "2026-05", size: 540, retention: [1.0] },
];
const ROWS = COHORTS.flatMap((c) =>
  c.retention.map((pct, period) => ({
    cohort_period: c.cohort,
    periods_since_signup: period,
    retention_pct: pct,
    cohort_size: c.size,
  }))
);

const baseBlock: Block = {
  id: "cohort-1",
  type: "cohort_retention",
  x: 0, y: 0, w: 8, h: 5,
  config: {
    queryId: "signups",
    title: "Signup cohort retention",
    subtitle: "% of cohort still active by month",
    cohortField: "cohort_period",
    periodField: "periods_since_signup",
    retentionField: "retention_pct",
    cohortSizeField: "cohort_size",
    cellFormat: "percent",
  },
};

const meta: Meta<typeof CohortRetentionBlock> = {
  title: "Blocks/CohortRetentionBlock",
  component: CohortRetentionBlock,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof CohortRetentionBlock>;

/** Full triangle — 5 cohorts at various ages, percent cells + cohort size column. */
export const Default: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: { signups: ROWS }, params: {} },
};

/** Count format instead of percent — verifies the cell-format switch. */
export const CountFormat: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, cellFormat: "count" } } as Block,
    report: REPORT_STUB,
    dataset: {
      signups: ROWS.map((r) => ({ ...r, retention_pct: Math.round(r.retention_pct * 500) })),
    },
    params: {},
  },
};

/** Single cohort — verifies the triangle renders sensibly with only one row. */
export const SingleCohort: Story = {
  args: {
    block: baseBlock,
    report: REPORT_STUB,
    dataset: { signups: ROWS.filter((r) => r.cohort_period === "2026-01") },
    params: {},
  },
};
