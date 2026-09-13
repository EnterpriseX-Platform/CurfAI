/**
 * MapBlock visual-regression stories — Curf (Harness 8).
 *
 * Caveat: the renderer fetches d3-geo / topojson-client / world-atlas
 * topology from a CDN at first mount (see MapBlock.tsx's module doc). In a
 * network-restricted CI/Chromatic sandbox the story may snapshot the
 * loading spinner rather than the rendered choropleth — still a valid
 * baseline (catches loading-state regressions), just not the full map.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { MapBlock } from "./MapBlock";
import type { Block, Report } from "@/lib/reporting/schema";

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook Map",
  pages: [],
  dataSources: [{ id: "regions", kind: "static" as const, rows: [] }],
} as unknown as Report;

const COUNTRY_ROWS = [
  { country: "USA", revenue: 1_250_000 },
  { country: "GBR", revenue: 320_000 },
  { country: "DEU", revenue: 410_000 },
  { country: "JPN", revenue: 275_000 },
  { country: "IND", revenue: 190_000 },
  { country: "BRA", revenue: 140_000 },
  { country: "AUS", revenue: 98_000 },
];

const baseBlock: Block = {
  id: "map-1",
  type: "map",
  x: 0, y: 0, w: 8, h: 6,
  config: {
    queryId: "regions",
    title: "Revenue by country",
    regionType: "country",
    regionField: "country",
    valueField: "revenue",
    aggregation: "sum",
    format: "compact",
    ramp: "primary",
  },
};

const meta: Meta<typeof MapBlock> = {
  title: "Blocks/MapBlock",
  component: MapBlock,
  parameters: { layout: "padded" },
  // MapBlock's root is `h-full`, same as ChartBlock — see the comment in
  // ChartBlock.stories.tsx. Without an explicit-height ancestor the SVG
  // projection has no viewport to size against.
  decorators: [(Story) => <div style={{ height: 400 }}><Story /></div>],
};
export default meta;

type Story = StoryObj<typeof MapBlock>;

/** World choropleth, primary ramp, compact number format. */
export const Default: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: { regions: COUNTRY_ROWS }, params: {} },
};

/** Emerald ramp — verifies the fixed (theme-invariant) ramp swap. */
export const EmeraldRamp: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, ramp: "emerald" } } as Block,
    report: REPORT_STUB, dataset: { regions: COUNTRY_ROWS }, params: {},
  },
};

/** Empty dataset — every region should render as the "no data" muted gray. */
export const Empty: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: { regions: [] }, params: {} },
};
