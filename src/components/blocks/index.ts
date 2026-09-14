/**
 * Block registry. Keyed by block type; one React component per entry.
 * Kept deliberately small so adding a new block type is a 3-file change
 * (schema.ts config, this registry, the component).
 *
 * Metadata (label/icon/defaultSize) lives in ./registryMeta, which has no
 * component imports — see that file's header for why. This module adds
 * `Component` on top of it for the consumers that actually render blocks.
 */
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
import { BLOCK_META, BLOCK_ORDER, type BlockMeta } from "./registryMeta";

type Entry = BlockMeta & {
  Component: React.ComponentType<BlockRenderContext>;
};

const COMPONENTS: Record<BlockType, React.ComponentType<BlockRenderContext>> = {
  title: TitleBlock,
  text: TextBlock,
  table: TableBlock,
  kpi: KpiBlock,
  chart: ChartBlock,
  image: ImageBlock,
  divider: DividerBlock,
  pageBreak: PageBreakBlock,
  callout: CalloutBlock,
  progress: ProgressBlock,
  pivot: PivotBlock,
  heatmap: HeatmapBlock,
  map: MapBlock,
  cohort_retention: CohortRetentionBlock,
  funnel: FunnelBlock,
};

export const BlockRegistry: Record<BlockType, Entry> = Object.fromEntries(
  (Object.keys(BLOCK_META) as BlockType[]).map((type) => [
    type,
    { ...BLOCK_META[type], Component: COMPONENTS[type] },
  ]),
) as Record<BlockType, Entry>;

export const BlockOrder: BlockType[] = BLOCK_ORDER;
