import type { BlockRenderContext } from "./types";

export function ImageBlock({ block }: BlockRenderContext) {
  if (block.type !== "image") return null;
  const { src, alt, fit } = block.config;
  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-md border border-border bg-muted/30">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="h-full w-full" style={{ objectFit: fit }} />
    </div>
  );
}
