/**
 * HeatmapBlock visual-regression stories — Curf (Harness 8).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { HeatmapBlock } from "./HeatmapBlock";
import type { Block, Report } from "@/lib/reporting/schema";

const REPORT_STUB = {
  id: "story-report",
  name: "Storybook Heatmap",
  pages: [],
  dataSources: [{ id: "activity", kind: "static" as const, rows: [] }],
} as unknown as Report;

// 5 weeks of daily activity, weekday-shaped (busier midweek, quiet weekends).
const CALENDAR_ROWS = Array.from({ length: 35 }, (_, i) => {
  const d = new Date(2026, 5, 1 + i);
  const dow = d.getDay();
  const base = dow === 0 || dow === 6 ? 2 : 8;
  return { date: d.toISOString().slice(0, 10), commits: base + Math.floor(Math.sin(i / 3) * 4 + 4) };
});

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = ["00", "04", "08", "12", "16", "20"];
const GRID_ROWS = DAYS.flatMap((day, di) =>
  HOURS.map((hour, hi) => ({
    day,
    hour,
    sessions: di < 5 && hi >= 2 && hi <= 4 ? 80 + (hi - 2) * 30 : 10 + di * 2,
  }))
);

const baseBlock: Block = {
  id: "heatmap-1",
  type: "heatmap",
  x: 0, y: 0, w: 8, h: 5,
  config: {
    queryId: "activity",
    title: "Daily commit activity",
    mode: "calendar",
    dateField: "date",
    valueField: "commits",
    aggregation: "sum",
    format: "number",
    ramp: "primary",
  },
};

const meta: Meta<typeof HeatmapBlock> = {
  title: "Blocks/HeatmapBlock",
  component: HeatmapBlock,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof HeatmapBlock>;

/** Calendar mode — GitHub-style year/month grid, primary ramp. */
export const Calendar: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: { activity: CALENDAR_ROWS }, params: {} },
};

/** Grid mode — day-of-week x hour-of-day matrix, verifies session peak visibility. */
export const Grid: Story = {
  args: {
    block: {
      ...baseBlock,
      config: {
        queryId: "activity", title: "Sessions by day and hour", mode: "grid",
        xField: "hour", yField: "day", valueField: "sessions",
        aggregation: "sum", format: "number", ramp: "emerald",
      },
    } as Block,
    report: REPORT_STUB, dataset: { activity: GRID_ROWS }, params: {},
  },
};

/** Rose ramp — verifies the ramp swap on calendar mode. */
export const RoseRamp: Story = {
  args: {
    block: { ...baseBlock, config: { ...baseBlock.config, ramp: "rose" } } as Block,
    report: REPORT_STUB, dataset: { activity: CALENDAR_ROWS }, params: {},
  },
};

/** Empty dataset — renders BlockEmptyState instead of a grid. */
export const Empty: Story = {
  args: { block: baseBlock, report: REPORT_STUB, dataset: { activity: [] }, params: {} },
};
