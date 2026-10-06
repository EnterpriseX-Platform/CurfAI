/**
 * Block templates — pre-configured single- or multi-block bundles users can
 * drop into the canvas with one click. These are intentionally generic
 * starting points (KPI/Chart/Table/Callout shapes) so they work even when no
 * data source is wired yet — the user fills in `queryId` + field names from
 * the property panel after dropping.
 *
 * Adding a new template = append an entry below, plus its blockTemplate.<id>
 * (name) and blockTemplate.<id>.desc keys in lib/i18n/dict.ts. No registry
 * plumbing — the palette reads this list directly.
 */
import type { BlockTemplateEntry } from "@/lib/reporting/store";

export type BlockTemplate = {
  id: string;
  /** Visual hint icon name from lucide-react (resolved in the palette). */
  icon: "DollarSign" | "TrendingUp" | "Table" | "PieChart" | "MessageSquareWarning" | "LayoutDashboard" | "FileText" | "Award";
  blocks: BlockTemplateEntry[];
};

export const BLOCK_TEMPLATES: BlockTemplate[] = [
  // ---------- Single-block presets ----------
  {
    id: "kpi-revenue",
    icon: "DollarSign",
    blocks: [
      {
        type: "kpi",
        x: 0, y: 0, w: 4, h: 3,
        config: {
          queryId: "",
          label: "Total revenue",
          valueField: "revenue",
          format: "currency",
        },
      },
    ],
  },
  {
    id: "kpi-percent",
    icon: "TrendingUp",
    blocks: [
      {
        type: "kpi",
        x: 0, y: 0, w: 4, h: 3,
        config: {
          queryId: "",
          label: "Conversion",
          valueField: "rate",
          format: "percent",
        },
      },
    ],
  },
  {
    id: "trend-chart",
    icon: "TrendingUp",
    blocks: [
      {
        type: "chart",
        x: 0, y: 0, w: 12, h: 6,
        config: {
          queryId: "",
          chartType: "area",
          title: "Trend over time",
          xField: "month",
          yFields: ["value"],
          stacked: false,
          showLegend: false,
        },
      },
    ],
  },
  {
    id: "category-bar",
    icon: "PieChart",
    blocks: [
      {
        type: "chart",
        x: 0, y: 0, w: 8, h: 6,
        config: {
          queryId: "",
          chartType: "bar",
          title: "By category",
          xField: "category",
          yFields: ["value"],
          stacked: false,
          showLegend: true,
        },
      },
    ],
  },
  {
    id: "top-10-table",
    icon: "Table",
    blocks: [
      {
        type: "table",
        x: 0, y: 0, w: 12, h: 8,
        config: {
          queryId: "",
          title: "Top results",
          columns: [],
          pageSize: 10,
          stripe: true,
          showTotals: true,
          actions: [],
        },
      },
    ],
  },
  {
    id: "callout-warning",
    icon: "MessageSquareWarning",
    blocks: [
      {
        type: "callout",
        x: 0, y: 0, w: 12, h: 3,
        config: {
          variant: "warning",
          title: "Heads up",
          body: "Edit this callout from the property panel.",
        },
      },
    ],
  },

  // ---------- Multi-block layouts ----------
  {
    id: "executive-header",
    icon: "LayoutDashboard",
    blocks: [
      {
        type: "title",
        x: 0, y: 0, w: 12, h: 2,
        config: { text: "Executive summary", subtitle: "Period at a glance", align: "left" },
      },
      {
        type: "kpi",
        x: 0, y: 2, w: 4, h: 3,
        config: { queryId: "", label: "Revenue", valueField: "revenue", format: "currency" },
      },
      {
        type: "kpi",
        x: 4, y: 2, w: 4, h: 3,
        config: { queryId: "", label: "Units", valueField: "units", format: "number" },
      },
      {
        type: "kpi",
        x: 8, y: 2, w: 4, h: 3,
        config: { queryId: "", label: "Margin", valueField: "margin", format: "percent" },
      },
    ],
  },
  {
    id: "kpi-row",
    icon: "Award",
    blocks: [
      {
        type: "kpi",
        x: 0, y: 0, w: 4, h: 3,
        config: { queryId: "", label: "Metric A", valueField: "a", format: "number" },
      },
      {
        type: "kpi",
        x: 4, y: 0, w: 4, h: 3,
        config: { queryId: "", label: "Metric B", valueField: "b", format: "number" },
      },
      {
        type: "kpi",
        x: 8, y: 0, w: 4, h: 3,
        config: { queryId: "", label: "Metric C", valueField: "c", format: "number" },
      },
    ],
  },
  {
    id: "chart-plus-table",
    icon: "FileText",
    blocks: [
      {
        type: "chart",
        x: 0, y: 0, w: 12, h: 6,
        config: {
          queryId: "",
          chartType: "bar",
          title: "Summary",
          xField: "category",
          yFields: ["value"],
          stacked: false,
          showLegend: true,
        },
      },
      {
        type: "table",
        x: 0, y: 6, w: 12, h: 8,
        config: {
          queryId: "",
          title: "Details",
          columns: [],
          pageSize: 25,
          stripe: true,
          showTotals: true,
          actions: [],
        },
      },
    ],
  },
];
