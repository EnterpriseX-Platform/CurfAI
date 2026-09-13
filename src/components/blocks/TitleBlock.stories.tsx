/**
 * TitleBlock visual-regression stories — Curf (Harness 8).
 *
 * One story per noteworthy variant. Chromatic snapshots each story across
 * the global theme toolbar and viewports configured in
 * .storybook/preview.tsx, so we get NxM coverage without authoring NxM
 * stories by hand.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { TitleBlock } from "./TitleBlock";
import type { Block, Report } from "@/lib/reporting/schema";

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook Title",
  pages: [],
  dataSources: [],
} as unknown as Report;

const baseBlock: Block = {
  id: "title-1",
  type: "title",
  x: 0, y: 0, w: 12, h: 2,
  config: {
    text: "Q3 Revenue Overview",
    subtitle: "All figures in USD, updated hourly",
    align: "left",
  },
};

const meta: Meta<typeof TitleBlock> = {
  title: "Blocks/TitleBlock",
  component: TitleBlock,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof TitleBlock>;

/** Left-aligned title + subtitle — the most common shape. */
export const Default: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: {}, params: {} },
};

/** Center alignment — verifies the text-center class applies to both lines. */
export const Centered: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, align: "center" } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Right alignment. */
export const RightAligned: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, align: "right" } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** No subtitle — verifies the subtitle paragraph doesn't render an empty gap. */
export const NoSubtitle: Story = {
  args: {
    block: { ...baseBlock, config: { text: "Q3 Revenue Overview", align: "left" } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Long title — verifies wrapping doesn't clip or overflow the block bounds. */
export const LongTitle: Story = {
  args: {
    block: {
      ...baseBlock,
      config: {
        text: "Enterprise + Mid-Market Net Revenue Retention Across All Regions",
        subtitle: "Combined view across every business unit and currency",
        align: "left",
      },
    } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};
