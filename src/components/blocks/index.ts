/**
 * Block registry. Keyed by block type; one React component per entry.
 * Kept deliberately small so adding a new block type is a 3-file change
 * (schema.ts config, this registry, the component).
 */
import { BarChart3, GalleryVertical, Heading1, Image as ImageIcon,
         Minus, SplitSquareVertical, Table2, Type, MessageSquareText, Activity, LayoutGrid, Grid3x3, Map as MapIcon, Users, Filter } from "lucide-react";
import { TitleBlock } from "./TitleBlock";
import { TextBlock } from "./TextBlock";
import { TableBlock } from "./TableBlock";
import { KpiBlock } from "./KpiBlock";
import { ChartBlock } from "./ChartBlock";
import { ImageBlock } from "./ImageBlock";
import { DividerBlock } from "./DividerBlock";
import { PageBreakBlock } from "./PageBreakBlock";
import { CalloutBlock } from "./CalloutBlock";
import { ProgressBlock } from "./ProgressBlock";
import { PivotBlock } from "./PivotBlock";
import { HeatmapBlock } from "./HeatmapBlock";
import { MapBlock } from "./MapBlock";
import { CohortRetentionBlock } from "./CohortRetentionBlock";
import { FunnelBlock } from "./FunnelBlock";
import type { BlockType } from "@/lib/reporting/schema";
import type { BlockRenderContext } from "./types";

type Entry = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  defaultSize: { w: number; h: number };
  Component: React.ComponentType<BlockRenderContext>;
};

export const BlockRegistry: Record<BlockType, Entry> = {
  title:     { label: "Title",      icon: Heading1,             defaultSize: { w: 12, h: 2 }, Component: TitleBlock },
  text:      { label: "Text",       icon: Type,                 defaultSize: { w: 12, h: 2 }, Component: TextBlock },
  table:     { label: "Table",      icon: Table2,               defaultSize: { w: 12, h: 8 }, Component: TableBlock },
  kpi:       { label: "KPI",        icon: GalleryVertical,      defaultSize: { w: 4,  h: 3 }, Component: KpiBlock },
  chart:     { label: "Chart",      icon: BarChart3,            defaultSize: { w: 8,  h: 6 }, Component: ChartBlock },
  image:     { label: "Image",      icon: ImageIcon,            defaultSize: { w: 4,  h: 4 }, Component: ImageBlock },
  divider:   { label: "Divider",    icon: Minus,                defaultSize: { w: 12, h: 1 }, Component: DividerBlock },
  pageBreak: { label: "Page Break", icon: SplitSquareVertical,  defaultSize: { w: 12, h: 1 }, Component: PageBreakBlock },
  callout:   { label: "Callout",    icon: MessageSquareText,    defaultSize: { w: 12, h: 3 }, Component: CalloutBlock },
  progress:  { label: "Progress",   icon: Activity,             defaultSize: { w: 6,  h: 3 }, Component: ProgressBlock },
  pivot:     { label: "Pivot",      icon: LayoutGrid,           defaultSize: { w: 12, h: 6 }, Component: PivotBlock },
  heatmap:   { label: "Heatmap",    icon: Grid3x3,              defaultSize: { w: 12, h: 5 }, Component: HeatmapBlock },
  map:       { label: "Map",        icon: MapIcon,              defaultSize: { w: 12, h: 6 }, Component: MapBlock },
  cohort_retention: { label: "Cohort retention", icon: Users,   defaultSize: { w: 12, h: 8 }, Component: CohortRetentionBlock },
  funnel:           { label: "Funnel",           icon: Filter,  defaultSize: { w: 12, h: 6 }, Component: FunnelBlock },
};

export const BlockOrder: BlockType[] = [
  "title", "text", "callout", "table", "kpi", "chart", "pivot", "heatmap", "map", "cohort_retention", "funnel", "progress", "image", "divider", "pageBreak",
];
