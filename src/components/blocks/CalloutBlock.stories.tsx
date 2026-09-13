/**
 * CalloutBlock visual-regression stories — Curf (Harness 8).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { CalloutBlock } from "./CalloutBlock";
import type { Block, Report } from "@/lib/reporting/schema";

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook Callout",
  pages: [],
  dataSources: [],
} as unknown as Report;

const baseBlock: Block = {
  id: "callout-1",
  type: "callout",
  x: 0, y: 0, w: 6, h: 3,
  config: {
    variant: "info",
    title: "Heads up",
    body: "This dashboard refreshes every 15 minutes during business hours.",
  },
};

const meta: Meta<typeof CalloutBlock> = {
  title: "Blocks/CalloutBlock",
  component: CalloutBlock,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof CalloutBlock>;

/** Info variant — the default. */
export const Info: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: {}, params: {} },
};

/** Success variant. */
export const Success: Story = {
  args: {
    block: {
      ...baseBlock,
      config: { variant: "success", title: "All checks passed", body: "Every scheduled watcher ran cleanly overnight." },
    } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Warning variant. */
export const Warning: Story = {
  args: {
    block: {
      ...baseBlock,
      config: { variant: "warning", title: "Approaching quota", body: "This workspace has used 92% of its monthly report quota." },
    } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Danger variant. */
export const Danger: Story = {
  args: {
    block: {
      ...baseBlock,
      config: { variant: "danger", title: "Sync failed", body: "The Salesforce connection has not synced in 3 days." },
    } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Neutral variant. */
export const Neutral: Story = {
  args: {
    block: {
      ...baseBlock,
      config: { variant: "neutral", title: "Tip", body: "Pin this chart to your Brief for a daily digest." },
    } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Body only, no title — verifies the title paragraph is omitted cleanly. */
export const BodyOnly: Story = {
  args: {
    block: { ...baseBlock, config: { variant: "info", title: "", body: "No action needed — everything is on track." } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};
