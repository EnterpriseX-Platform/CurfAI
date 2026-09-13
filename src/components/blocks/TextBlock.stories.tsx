/**
 * TextBlock visual-regression stories — Curf (Harness 8).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { TextBlock } from "./TextBlock";
import type { Block, Report } from "@/lib/reporting/schema";

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook Text",
  pages: [],
  dataSources: [],
} as unknown as Report;

const baseBlock: Block = {
  id: "text-1",
  type: "text",
  x: 0, y: 0, w: 6, h: 3,
  config: {
    text: "This report summarizes performance across all active regions for the current quarter.",
    align: "left",
    size: "md",
  },
};

const meta: Meta<typeof TextBlock> = {
  title: "Blocks/TextBlock",
  component: TextBlock,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof TextBlock>;

/** Medium size, left-aligned — the default body-text shape. */
export const Default: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: {}, params: {} },
};

/** Small size — verifies the text-sm class + tighter line height. */
export const Small: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, size: "sm" } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Large size — verifies the text-lg class. */
export const Large: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, size: "lg" } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Center alignment. */
export const Centered: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, align: "center" } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Multi-paragraph text — verifies whitespace-pre-wrap preserves line breaks. */
export const Multiline: Story = {
  args: {
    block: {
      ...baseBlock,
      config: {
        ...baseBlock.config,
        text: "Q3 highlights:\n\n- Revenue grew 12% quarter over quarter.\n- Churn held steady at 2.1%.\n- Two new enterprise logos closed in EMEA.",
      },
    } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Empty text — verifies the block renders without crashing on a blank string. */
export const Empty: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, text: "" } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};
