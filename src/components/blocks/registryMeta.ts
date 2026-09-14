/**
 * Static per-block-type metadata: label, icon, default canvas size.
 *
 * Deliberately has NO import of the block components themselves. Split
 * out of index.ts because several consumers (the designer store, the
 * empty state, the property panel, the palette) only ever read this
 * metadata, never `.Component` — but importing it from the full barrel
 * pulled in every block component's own dependency tree, including
 * KpiBlock's, which reaches into the paid client registry (@/ee/client).
 * Once that registry started including a component that itself imports
 * the designer store (SuggestChartButton), the store's barrel import
 * closed a require cycle back to KpiBlock ("Cannot access 'eeClient'
 * before initialization"). Metadata-only consumers import from here
 * instead, so they carry none of that.
 */
import {
  BarChart3, GalleryVertical, Heading1, Image as ImageIcon,
  Minus, SplitSquareVertical, Table2, Type, MessageSquareText, Activity,
  LayoutGrid, Grid3x3, Map as MapIcon, Users, Filter,
} from "lucide-react";
import type { BlockType } from "@/lib/reporting/schema";

export type BlockMeta = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  defaultSize: { w: number; h: number };
};

export const BLOCK_META: Record<BlockType, BlockMeta> = {
  title:     { label: "Title",      icon: Heading1,             defaultSize: { w: 12, h: 2 } },
  text:      { label: "Text",       icon: Type,                 defaultSize: { w: 12, h: 2 } },
  table:     { label: "Table",      icon: Table2,               defaultSize: { w: 12, h: 8 } },
  kpi:       { label: "KPI",        icon: GalleryVertical,      defaultSize: { w: 4,  h: 3 } },
  chart:     { label: "Chart",      icon: BarChart3,            defaultSize: { w: 8,  h: 6 } },
  image:     { label: "Image",      icon: ImageIcon,            defaultSize: { w: 4,  h: 4 } },
  divider:   { label: "Divider",    icon: Minus,                defaultSize: { w: 12, h: 1 } },
  pageBreak: { label: "Page Break", icon: SplitSquareVertical,  defaultSize: { w: 12, h: 1 } },
  callout:   { label: "Callout",    icon: MessageSquareText,    defaultSize: { w: 12, h: 3 } },
  progress:  { label: "Progress",   icon: Activity,             defaultSize: { w: 6,  h: 3 } },
  pivot:     { label: "Pivot",      icon: LayoutGrid,           defaultSize: { w: 12, h: 6 } },
  heatmap:   { label: "Heatmap",    icon: Grid3x3,              defaultSize: { w: 12, h: 5 } },
  map:       { label: "Map",        icon: MapIcon,              defaultSize: { w: 12, h: 6 } },
  cohort_retention: { label: "Cohort retention", icon: Users,   defaultSize: { w: 12, h: 8 } },
  funnel:           { label: "Funnel",           icon: Filter,  defaultSize: { w: 12, h: 6 } },
};

export const BLOCK_ORDER: BlockType[] = [
  "title", "text", "callout", "table", "kpi", "chart", "pivot", "heatmap", "map", "cohort_retention", "funnel", "progress", "image", "divider", "pageBreak",
];
