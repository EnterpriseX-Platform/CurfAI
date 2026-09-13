import { interpolate } from "@/lib/reporting/interpolate";
import type { BlockRenderContext } from "./types";
import { cn } from "@/lib/utils";

export function TitleBlock({ block, params }: BlockRenderContext) {
  if (block.type !== "title") return null;
  const { text, subtitle, align } = block.config;
  const title = interpolate(text, { params });
  const sub = subtitle ? interpolate(subtitle, { params }) : undefined;
  return (
    <div className={cn("w-full", align === "center" && "text-center", align === "right" && "text-right")}>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">{title}</h1>
      {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
    </div>
  );
}
