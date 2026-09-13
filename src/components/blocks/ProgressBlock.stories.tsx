/**
 * ProgressBlock visual-regression stories — Curf (Harness 8).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ProgressBlock } from "./ProgressBlock";
import type { Block, Report } from "@/lib/reporting/schema";

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook Progress",
  pages: [],
  dataSources: [{ id: "quota", kind: "static" as const, rows: [] }],
} as unknown as Report;

const baseBlock: Block = {
  id: "progress-1",
  type: "progress",
  x: 0, y: 0, w: 4, h: 2,
  config: {
    label: "Report quota used",
    value: 68,
    showPercent: true,
    color: "primary",
  },
};

const meta: Meta<typeof ProgressBlock> = {
  title: "Blocks/ProgressBlock",
  component: ProgressBlock,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof ProgressBlock>;

/** Literal value (no query binding), primary color, percent shown. */
export const Default: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: {}, params: {} },
};

/** Query-bound value — pulls from the first dataset row's field. */
export const QueryBound: Story = {
  args: {
    block: {
      ...baseBlock,
      config: { label: "Storage used", queryId: "quota", valueField: "pct", showPercent: true, color: "amber" },
    } as Block,
    report: REPORT_STUB,
    dataset: { quota: [{ pct: 41 }] },
    params: {},
  },
};

/** Near-full — verifies the danger color at high completion. */
export const NearComplete: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, value: 97, color: "rose", label: "Watcher budget consumed" } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/** No percent label — bar only. */
export const NoPercentLabel: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, showPercent: false } } as Block,
    report: REPORT_STUB, dataset: {}, params: {},
  },
};

/**
 * List mode — `labelField` turns one block into a ranked set of bars, the
 * "outcome engines" pattern. Without `labelField` the same config would
 * render a single bar off row 0.
 */
export const List: Story = {
  args: {
    block: {
      ...baseBlock,
      x: 0, y: 0, w: 6, h: 5,
      config: {
        label: "Outcome engines",
        queryId: "quota",
        labelField: "name",
        descriptionField: "detail",
        valueField: "pct",
        maxRows: 10,
        showPercent: true,
        color: "emerald",
      },
    } as Block,
    report: REPORT_STUB,
    dataset: {
      quota: [
        { name: "Claim recovery", detail: "12 sites · ฿48.2M unbilled", pct: 72 },
        { name: "Cash consolidation", detail: "Weekly ledger sweep", pct: 45 },
        { name: "Risk watch", detail: "3 open, 1 new this week", pct: 88 },
      ],
    },
    params: {},
  },
};

/** List mode with rows past `maxRows` — verifies the ceiling truncates. */
export const ListTruncated: Story = {
  args: {
    block: {
      ...baseBlock,
      x: 0, y: 0, w: 6, h: 4,
      config: {
        label: "Top sites", queryId: "quota", labelField: "name", valueField: "pct",
        maxRows: 3, showPercent: true, color: "primary",
      },
    } as Block,
    report: REPORT_STUB,
    dataset: {
      quota: Array.from({ length: 12 }, (_, i) => ({ name: `Site ${i + 1}`, pct: 95 - i * 6 })),
    },
    params: {},
  },
};

/** Empty dataset on a query-bound block — renders BlockEmptyState instead of a bar. */
export const Empty: Story = {
  args: {
    block: {
      ...baseBlock,
      config: { label: "Storage used", queryId: "quota", valueField: "pct", showPercent: true, color: "primary" },
    } as Block,
    report: REPORT_STUB,
    dataset: { quota: [] },
    params: {},
  },
};
