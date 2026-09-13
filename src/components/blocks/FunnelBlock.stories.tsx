/**
 * FunnelBlock visual-regression stories — Curf (Harness 8).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { FunnelBlock } from "./FunnelBlock";
import type { Block, Report } from "@/lib/reporting/schema";

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook Funnel",
  pages: [],
  dataSources: [{ id: "activation", kind: "static" as const, rows: [] }],
} as unknown as Report;

const ROWS = [
  { step_name: "Visited pricing page", users_reached: 12_400 },
  { step_name: "Started signup", users_reached: 4_100 },
  { step_name: "Verified email", users_reached: 3_350 },
  { step_name: "Completed onboarding", users_reached: 2_180 },
  { step_name: "Upgraded to paid", users_reached: 640 },
];

const baseBlock: Block = {
  id: "funnel-1",
  type: "funnel",
  x: 0, y: 0, w: 6, h: 5,
  config: {
    queryId: "activation",
    title: "Signup → paid conversion",
    subtitle: "Last 30 days",
    stepField: "step_name",
    reachedField: "users_reached",
  },
};

const meta: Meta<typeof FunnelBlock> = {
  title: "Blocks/FunnelBlock",
  component: FunnelBlock,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof FunnelBlock>;

/** 5-step funnel, decreasing-width bars, derived conversion percentages. */
export const Default: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: { activation: ROWS }, params: {} },
};

/** Two steps only — verifies the layout doesn't assume 3+ steps. */
export const TwoSteps: Story = {
  args: {
    block: baseBlock,
    report: REPORT_STUB,
    dataset: { activation: ROWS.slice(0, 2) },
    params: {},
  },
};

/** No rows — the funnel's own "returned no rows" fallback message. */
export const Empty: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: { activation: [] }, params: {} },
};
