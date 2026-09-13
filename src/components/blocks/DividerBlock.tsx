import type { BlockRenderContext } from "./types";

export function DividerBlock({ block }: BlockRenderContext) {
  if (block.type !== "divider") return null;
  const { style, thickness } = block.config;
  return (
    <div className="flex h-full w-full items-center">
      <hr
        className="w-full border-border"
        style={{ borderTopStyle: style, borderTopWidth: thickness }}
      />
    </div>
  );
}
