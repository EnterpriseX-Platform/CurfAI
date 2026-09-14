"use client";
import { useState } from "react";
import {
  DollarSign, TrendingUp, Table, PieChart, MessageSquareWarning,
  LayoutDashboard, FileText, Award,
} from "lucide-react";
import { BLOCK_META as BlockRegistry, BLOCK_ORDER as BlockOrder } from "@/components/blocks/registryMeta";
import { useDesignerStore } from "@/lib/reporting/store";
import type { BlockType } from "@/lib/reporting/schema";
import { BLOCK_TEMPLATES, type BlockTemplate } from "@/lib/reporting/blockTemplates";

// Group blocks into categories for a cleaner palette UX.
const GROUPS: { label: string; types: BlockType[] }[] = [
  { label: "Content",   types: ["title", "text", "callout", "divider", "pageBreak"] },
  { label: "Data",      types: ["table", "kpi", "chart", "progress"] },
  { label: "Visualize", types: ["pivot", "heatmap", "map"] },
  { label: "Media",     types: ["image"] },
];

const TEMPLATE_ICONS = {
  DollarSign, TrendingUp, Table, PieChart, MessageSquareWarning,
  LayoutDashboard, FileText, Award,
} as const;

export function BlockPalette() {
  const addBlock = useDesignerStore((s) => s.addBlock);
  const addBlockTemplate = useDesignerStore((s) => s.addBlockTemplate);
  const [tab, setTab] = useState<"blocks" | "templates">("blocks");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border/60 px-3 pt-3 pb-2">
        <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-0.5">
          <button
            onClick={() => setTab("blocks")}
            className={"rounded-sm px-2 py-1 text-[11px] font-medium transition-colors " + (tab === "blocks" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
          >
            Blocks
          </button>
          <button
            onClick={() => setTab("templates")}
            className={"rounded-sm px-2 py-1 text-[11px] font-medium transition-colors " + (tab === "templates" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
          >
            Templates
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {tab === "blocks" ? (
          <div className="flex flex-col gap-5">
            <p className="px-1 text-[11px] text-muted-foreground">Click to insert at the end of the page.</p>
            {GROUPS.map((g) => (
              <div key={g.label} className="space-y-1">
                <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">{g.label}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {g.types.filter((t) => BlockOrder.includes(t)).map((type) => {
                    const entry = BlockRegistry[type];
                    const Icon = entry.icon;
                    return (
                      <button
                        key={type}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("application/json", JSON.stringify({ type }));
                          e.dataTransfer.dropEffect = "copy";
                        }}
                        onClick={() => addBlock(type)}
                        title={"Insert " + entry.label}
                        className="group flex flex-col items-start gap-1 rounded-lg border border-transparent bg-background px-2.5 py-2.5 text-left text-xs text-foreground shadow-xs transition-all hover:border-primary/30 hover:bg-primary/5 hover:shadow-sm select-none"
                      >
                        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="font-medium">{entry.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="px-1 text-[11px] text-muted-foreground">Pre-built layouts. Drop in, then wire data fields from the property panel.</p>
            {BLOCK_TEMPLATES.map((tpl) => (
              <TemplateCard key={tpl.id} tpl={tpl} onInsert={() => addBlockTemplate(tpl.blocks)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TemplateCard({ tpl, onInsert }: { tpl: BlockTemplate; onInsert: () => void }) {
  const Icon = TEMPLATE_ICONS[tpl.icon];
  return (
    <button
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/json", JSON.stringify({ isTemplate: true, id: tpl.id }));
        e.dataTransfer.dropEffect = "copy";
      }}
      onClick={onInsert}
      className="group flex w-full items-start gap-2.5 rounded-lg border border-border bg-background p-2.5 text-left transition-all hover:border-primary/30 hover:bg-primary/5 select-none"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-xs font-medium leading-tight">{tpl.label}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground line-clamp-2">{tpl.description}</div>
        <div className="mt-1 inline-flex rounded-sm bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
          {tpl.blocks.length === 1 ? "1 block" : tpl.blocks.length + " blocks"}
        </div>
      </div>
    </button>
  );
}
