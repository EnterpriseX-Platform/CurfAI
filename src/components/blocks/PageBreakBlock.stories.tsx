/**
 * PageBreakBlock visual-regression stories — Curf (Harness 8).
 *
 * The component only reads `print` — everything else in args exists just
 * to satisfy BlockRenderContext's required fields.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { PageBreakBlock } from "./PageBreakBlock";
import type { Block, Report } from "@/lib/reporting/schema";

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook Page Break",
  pages: [],
  dataSources: [],
} as unknown as Report;

const baseBlock: Block = {
  id: "pagebreak-1",
  type: "pageBreak",
  x: 0, y: 0, w: 12, h: 1,
  config: {},
};

const meta: Meta<typeof PageBreakBlock> = {
  title: "Blocks/PageBreakBlock",
  component: PageBreakBlock,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof PageBreakBlock>;

/** Designer/viewer surface — visible "— page break —" marker. */
export const Designer: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: {}, params: {}, print: false },
};

/** PDF export path — renders an invisible break-after spacer instead of the marker. */
export const Print: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: {}, params: {}, print: true },
};
