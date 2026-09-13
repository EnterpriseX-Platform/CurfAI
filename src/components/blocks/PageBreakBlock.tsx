import type { BlockRenderContext } from "./types";

/**
 * In the designer/viewer, render as a marker. In the PDF path, the
 * wrapper applies CSS `break-after: page` so Puppeteer starts a new page.
 */
export function PageBreakBlock({ print }: BlockRenderContext) {
  if (print) return <div style={{ breakAfter: "page" }} />;
  return (
    <div className="flex h-full w-full items-center justify-center text-xs uppercase tracking-wide text-muted-foreground">
      — page break —
    </div>
  );
}
