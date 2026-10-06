import { InterpolatedText } from "./InterpolatedText";
import type { BlockRenderContext } from "./types";
import { cn } from "@/lib/utils";

export function TitleBlock({ block, params }: BlockRenderContext) {
  if (block.type !== "title") return null;
  const { text, subtitle, align } = block.config;
  return (
    <div className={cn("w-full", align === "center" && "text-center", align === "right" && "text-right")}>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground"><InterpolatedText template={text} params={params} /></h1>
      {subtitle && <p className="mt-1 text-sm text-muted-foreground"><InterpolatedText template={subtitle} params={params} /></p>}
    </div>
  );
}
