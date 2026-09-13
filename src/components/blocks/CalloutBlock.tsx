import { Info, CheckCircle2, AlertTriangle, XCircle, Lightbulb } from "lucide-react";
import type { BlockRenderContext } from "./types";

const VARIANTS: Record<string, { icon: React.ComponentType<{ className?: string }>; cls: string; iconCls: string }> = {
  info:    { icon: Info,          cls: "border-primary/60 bg-primary-soft text-primary-ink  ",               iconCls: "text-primary" },
  success: { icon: CheckCircle2,  cls: "border-success/60 bg-success/10 text-success  ", iconCls: "text-success" },
  warning: { icon: AlertTriangle, cls: "border-warning/60 bg-warning/10 text-warning  ",       iconCls: "text-warning" },
  danger:  { icon: XCircle,       cls: "border-destructive/60 bg-destructive/10 text-destructive  ",             iconCls: "text-destructive" },
  neutral: { icon: Lightbulb,     cls: "border-border bg-muted/40 text-foreground",                                                       iconCls: "text-muted-foreground" },
};

export function CalloutBlock({ block }: BlockRenderContext) {
  if (block.type !== "callout") return null;
  const v = VARIANTS[block.config.variant] ?? VARIANTS.info;
  const Icon = v.icon;
  return (
    <div className={`flex h-full items-start gap-3 overflow-hidden rounded-lg border p-4 ${v.cls}`}>
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${v.iconCls}`} />
      <div className="min-w-0 flex-1">
        {block.config.title && <p className="mb-0.5 text-sm font-semibold">{block.config.title}</p>}
        {block.config.body && <p className="whitespace-pre-wrap text-xs leading-relaxed opacity-90">{block.config.body}</p>}
      </div>
    </div>
  );
}
