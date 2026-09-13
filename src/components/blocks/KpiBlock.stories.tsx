/**
 * KpiBlock visual-regression stories — Curf (Harness 8).
 *
 * One story per noteworthy variant. Chromatic snapshots each story across
 * the global theme toolbar (default / dark / midnight / sunrise / sage)
 * and viewports (mobile / tablet / desktop) configured in
 * .storybook/preview.tsx, so we get NxM coverage without authoring NxM
 * stories by hand.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { KpiBlock } from "./KpiBlock";
import type { Block, Report } from "@/lib/reporting/schema";
import type { ProvenanceRecord } from "@/lib/reporting/provenance";

// A proof record shaped exactly like the runner's, so the verified seal and
// the receipt row (sha256 · run · rows) render the way they do on a real run.
const PROOF: ProvenanceRecord = {
  queryId: "revenue",
  queryName: "Revenue",
  queryHash: "3f9a1c4e7b2d9f0a6c8e5d1b4a7f2c9e3b6d8a1f4c7e0b5d9a2f6c8e1b4d7a3c",
  runAt: "2026-09-08T06:05:12.000Z",
  durationMs: 1800,
  rowCount: 42,
  dataHash: "3f9a7b2c1d4e6f8a0b9c5d7e2f1a4b6c8d0e9f3a5b7c1d2e4f6a8b0c9d1e2fc2",
  dataSourceName: "warehouse",
  dataSourceKind: "postgres",
};
const PROVENANCE = { revenue: PROOF };

// Minimal Report stub — only the fields KpiBlock reads (`dataSources` for
// the ShowWorkButton reverse-lookup). The `as Report` cast keeps Storybook
// from needing every optional theme/page field; the block itself only
// touches `dataSources`.
const REPORT_STUB = {
  id: "story-report",
  name: "Storybook KPI",
  pages: [],
  dataSources: [{ id: "revenue", kind: "static" as const, rows: [] }],
} as unknown as Report;

const baseBlock: Block = {
  id: "kpi-1",
  type: "kpi",
  x: 0, y: 0, w: 3, h: 2,
  config: {
    queryId: "revenue",
    label: "Annual recurring revenue",
    valueField: "value",
    format: "currency",
    compareField: "prior",
  },
};

const meta: Meta<typeof KpiBlock> = {
  title: "Blocks/KpiBlock",
  component: KpiBlock,
  parameters: {
    layout: "padded",
  },
};
export default meta;

type Story = StoryObj<typeof KpiBlock>;

const TREND = [
  { v: 11_000_000 }, { v: 12_500_000 }, { v: 13_900_000 },
  { v: 14_200_000 }, { v: 15_700_000 }, { v: 16_400_000 },
  { v: 17_122_163 },
];
const withSpark = (h: number): Block => ({
  ...baseBlock,
  h,
  config: { ...baseBlock.config, sparkQueryId: "trend", sparkValueField: "v", sparkPositive: "up" },
} as Block);

/** Headline number with positive delta — the most common KPI shape (h: 3, "compact"). */
export const Default: Story = {
  args: {
    block: { ...baseBlock, h: 3 },
    report: REPORT_STUB,
    dataset: { revenue: [{ value: 17_122_163, prior: 14_900_000 }] },
    params: {},
    provenance: PROVENANCE,
  },
};

/** Negative delta — verifies the red color + downward triangle. */
export const NegativeDelta: Story = {
  args: {
    block: { ...baseBlock, h: 3 },
    report: REPORT_STUB,
    dataset: { revenue: [{ value: 12_000_000, prior: 14_900_000 }] },
    params: {},
    provenance: PROVENANCE,
  },
};

/** Sparkline variant (h: 4, "mid") — pulls a separate time-series query. */
export const WithSparkline: Story = {
  args: {
    block: withSpark(4),
    report: REPORT_STUB,
    dataset: { revenue: [{ value: 17_122_163, prior: 14_900_000 }], trend: TREND },
    params: {},
    provenance: PROVENANCE,
  },
};

/** h: 5 ("tall") — adds the receipt row under the sparkline. */
export const Tall: Story = {
  args: {
    block: withSpark(5),
    report: REPORT_STUB,
    dataset: { revenue: [{ value: 17_122_163, prior: 14_900_000 }], trend: TREND },
    params: {},
    provenance: PROVENANCE,
  },
};

/**
 * h: 6 ("hero") — the full provenance card: seal, value, delta, sparkline,
 * receipt, and the Why? / Replay actions (they need a report id; offline in
 * Storybook they fail gracefully).
 */
export const Hero: Story = {
  args: {
    block: withSpark(6),
    report: REPORT_STUB,
    dataset: { revenue: [{ value: 17_122_163, prior: 14_900_000 }], trend: TREND },
    params: {},
    provenance: PROVENANCE,
    reportDbId: "story-report",
  },
};

/** Long label with no compare — verifies two-line clamp + baseline alignment. */
export const LongLabel: Story = {
  args: {
    block: {
      ...baseBlock,
      config: {
        ...baseBlock.config,
        label: "Net revenue retention across enterprise + mid-market customers",
        compareField: undefined,
      },
    } as Block,
    report: REPORT_STUB,
    dataset: { revenue: [{ value: 1.18 }] },
    params: {},
  },
};

/** Percent format — verifies the formatter switch + small-number sizing. */
export const Percent: Story = {
  args: {
    block: {
      ...baseBlock,
      config: { ...baseBlock.config, label: "Conversion", format: "percent", compareField: undefined },
    } as Block,
    report: REPORT_STUB,
    dataset: { revenue: [{ value: 0.412 }] },
    params: {},
  },
};

/** Empty dataset — verifies em-dash fallback. */
export const Empty: Story = {
  args: {
    block: baseBlock,
    report: REPORT_STUB,
    dataset: { revenue: [] },
    params: {},
  },
};
