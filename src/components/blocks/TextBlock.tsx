import { interpolate } from "@/lib/reporting/interpolate";
import type { BlockRenderContext } from "./types";
import { cn } from "@/lib/utils";

export function TextBlock({ block, params }: BlockRenderContext) {
  if (block.type !== "text") return null;
  const { text, align, size } = block.config;
  const content = interpolate(text, { params });
  return (
    <p
      className={cn(
        "whitespace-pre-wrap text-foreground",
        size === "sm" && "text-sm",
        size === "md" && "text-base",
        size === "lg" && "text-lg",
        align === "center" && "text-center",
        align === "right" && "text-right"
      )}
    >
      {content}
    </p>
  );
}
