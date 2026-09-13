/**
 * DividerBlock visual-regression stories — Curf (Harness 8).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { DividerBlock } from "./DividerBlock";
import type { Block, Report } from "@/lib/reporting/schema";

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook Divider",
  pages: [],
  dataSources: [],
} as unknown as Report;

const baseBlock: Block = {
  id: "divider-1",
  type: "divider",
  x: 0, y: 0, w: 12, h: 1,
  config: { style: "solid", thickness: 1 },
};

const meta: Meta<typeof DividerBlock> = {
  title: "Blocks/DividerBlock",
  component: DividerBlock,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof DividerBlock>;

/** Solid, 1px — the default. */
export const Solid: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: {}, params: {} },
};

/** Dashed style. */
export const Dashed: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, style: "dashed" } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Dotted style. */
export const Dotted: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, style: "dotted" } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Max thickness — verifies the border-top-width scales visibly. */
export const Thick: Story = {
  args: {
    block: { ...baseBlock, config: { style: "solid", thickness: 8 } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};
