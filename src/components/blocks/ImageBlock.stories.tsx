/**
 * ImageBlock visual-regression stories — Curf (Harness 8).
 *
 * Uses inline SVG data URIs instead of a network-hosted image so Chromatic
 * snapshots stay deterministic (no fetch flakiness / rate limits).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ImageBlock } from "./ImageBlock";
import type { Block, Report } from "@/lib/reporting/schema";

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook Image",
  pages: [],
  dataSources: [],
} as unknown as Report;

const WIDE_SVG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#dbeafe"/><rect x="40" y="40" width="560" height="280" rx="12" fill="#3b82f6"/><text x="320" y="190" font-size="28" fill="white" text-anchor="middle" font-family="sans-serif">Company Logo</text></svg>'
  );

const baseBlock: Block = {
  id: "image-1",
  type: "image",
  x: 0, y: 0, w: 6, h: 4,
  config: { src: WIDE_SVG, alt: "Company logo", fit: "contain" },
};

const meta: Meta<typeof ImageBlock> = {
  title: "Blocks/ImageBlock",
  component: ImageBlock,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof ImageBlock>;

/** Contain fit — the default, no cropping. */
export const Default: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: {}, params: {} },
};

/** Cover fit — crops to fill the block bounds. */
export const Cover: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, fit: "cover" } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Fill fit — stretches to the block's exact w/h, ignoring aspect ratio. */
export const Fill: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, fit: "fill" } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** Broken image — verifies the frame still renders sensibly on a load error. */
export const BrokenSrc: Story = {
  args: {
    block: { ...baseBlock, config: { src: "/does-not-exist.png", alt: "Missing asset", fit: "contain" } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};
