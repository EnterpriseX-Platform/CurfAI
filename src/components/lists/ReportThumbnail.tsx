import { cn } from "@/lib/utils";
import { THUMB_COLS, type ThumbCell, type ThumbGlyph, type ThumbModel } from "./thumbnailModel";

/**
 * Draws a ThumbModel: each block a panel at its grid position (in percent, so
 * the miniature scales to any frame), with a glyph of what it is inside. App
 * chrome tokens only — the marks use the accent, the frame the neutral scale.
 */

const BARS = [42, 70, 52, 84, 60, 96];
const ink = "fill-primary";

function Glyph({ g }: { g: ThumbGlyph }) {
  switch (g) {
    case "kpi":
      return (
        <div className="flex h-full w-full flex-col justify-center gap-[3px] px-1">
          <i className="block h-[2px] w-1/2 rounded-full bg-faint opacity-60" />
          <i className="block h-[4px] w-3/4 rounded-full bg-foreground opacity-60" />
        </div>
      );
    case "bar":
      return (
        <svg viewBox="0 0 60 40" preserveAspectRatio="none" className="h-full w-full" aria-hidden>
          {BARS.map((h, i) => (
            <rect key={i} x={2 + i * 10} y={40 - (h * 38) / 100} width={7} height={(h * 38) / 100} className={ink} opacity={i === BARS.length - 1 ? 1 : 0.7} />
          ))}
        </svg>
      );
    case "line":
    case "area":
      return (
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-full w-full text-primary" aria-hidden>
          {g === "area" && <polygon points="0,40 0,30 20,22 40,26 60,12 80,18 100,6 100,40" className={ink} opacity={0.25} />}
          <polyline points="0,30 20,22 40,26 60,12 80,18 100,6" fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
      );
    case "scatter":
      return (
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-full w-full" aria-hidden>
          {[[10, 30], [24, 24], [38, 28], [50, 16], [64, 20], [78, 10], [90, 14]].map(([x, y], i) => (
            <rect key={i} x={x} y={y} width={4} height={5} rx={2} className={ink} opacity={0.8} />
          ))}
        </svg>
      );
    case "pie":
      return (
        <svg viewBox="0 0 40 40" className="h-full w-full" aria-hidden>
          <circle cx="20" cy="20" r="13" fill="none" className="stroke-primary" strokeOpacity={0.25} strokeWidth="8" />
          <circle cx="20" cy="20" r="13" fill="none" className="stroke-primary" strokeWidth="8" strokeDasharray="51 82" transform="rotate(-90 20 20)" />
        </svg>
      );
    case "gauge":
      return (
        <svg viewBox="0 0 40 24" className="h-full w-full" aria-hidden>
          <path d="M6 21 A14 14 0 0 1 34 21" fill="none" className="stroke-primary" strokeOpacity={0.25} strokeWidth="6" />
          <path d="M6 21 A14 14 0 0 1 27 9" fill="none" className="stroke-primary" strokeWidth="6" />
        </svg>
      );
    case "funnel":
      return (
        <svg viewBox="0 0 40 30" className="h-full w-full" aria-hidden>
          {[36, 26, 16].map((w, i) => (
            <rect key={i} x={(40 - w) / 2} y={2 + i * 9} width={w} height={7} rx={1} className={ink} opacity={1 - i * 0.25} />
          ))}
        </svg>
      );
    case "map":
      return (
        <svg viewBox="0 0 40 30" className="h-full w-full" aria-hidden>
          <path d="M6 10 L14 6 L20 9 L26 5 L34 9 L33 17 L27 24 L19 22 L12 25 L7 18 Z" className={ink} opacity={0.35} />
          <path d="M20 9 L26 5 L34 9 L33 17 L25 15 Z" className={ink} opacity={0.85} />
        </svg>
      );
    case "heatmap":
      return (
        <div className="grid h-full w-full grid-cols-4 grid-rows-3 gap-[2px] p-[2px]">
          {[0.9, 0.4, 0.6, 0.2, 0.3, 0.8, 0.5, 0.7, 0.6, 0.2, 0.9, 0.4].map((o, i) => (
            <i key={i} className="block rounded-[1px] bg-primary" style={{ opacity: o }} />
          ))}
        </div>
      );
    case "table":
      return (
        <div className="flex h-full w-full flex-col gap-[3px] overflow-hidden p-[2px]">
          <i className="block h-[3px] w-full shrink-0 rounded-full bg-foreground opacity-40" />
          {Array.from({ length: 8 }, (_, i) => (
            <i key={i} className="block h-[2px] w-full shrink-0 rounded-full bg-faint opacity-40" />
          ))}
        </div>
      );
    case "progress":
      return (
        <div className="flex h-full w-full items-center px-1">
          <div className="h-[4px] w-full overflow-hidden rounded-full bg-primary-soft">
            <i className="block h-full w-2/3 bg-primary" />
          </div>
        </div>
      );
    case "image":
      return (
        <svg viewBox="0 0 40 30" className="h-full w-full" aria-hidden>
          <path d="M4 26 L15 14 L22 20 L28 15 L36 26 Z" className="fill-faint" opacity={0.5} />
          <circle cx="29" cy="8" r="3" className="fill-faint" opacity={0.5} />
        </svg>
      );
    case "title":
      return (
        <div className="flex h-full w-full items-center">
          <i className="block h-[4px] w-2/5 rounded-full bg-foreground opacity-60" />
        </div>
      );
    case "divider":
      return <div className="flex h-full w-full items-center"><i className="block h-px w-full bg-border" /></div>;
    case "text":
    default:
      return (
        <div className="flex h-full w-full flex-col gap-[3px] overflow-hidden pt-[2px]">
          {["w-full", "w-11/12", "w-4/5", "w-full", "w-3/5"].map((w, i) => (
            <i key={i} className={cn("block h-[2px] shrink-0 rounded-full bg-faint opacity-50", w)} />
          ))}
        </div>
      );
  }
}

/** Panels for charts, tables and tiles; bare marks for words and rules, as on the page. */
const FRAMED = new Set<ThumbGlyph>(["kpi", "bar", "line", "area", "pie", "gauge", "scatter", "funnel", "table", "heatmap", "map", "image"]);

function Cell({ c, rows }: { c: ThumbCell; rows: number }) {
  return (
    <div
      className="absolute p-[2px]"
      style={{
        left: `${(c.x / THUMB_COLS) * 100}%`, width: `${(c.w / THUMB_COLS) * 100}%`,
        top: `${(c.y / rows) * 100}%`, height: `${(c.h / rows) * 100}%`,
      }}
    >
      <div className={cn("flex h-full w-full min-h-0 min-w-0 items-center justify-center overflow-hidden",
        FRAMED.has(c.glyph) ? "rounded-[4px] border border-border bg-card p-[3px]" : "px-[2px]")}>
        <Glyph g={c.glyph} />
      </div>
    </div>
  );
}

export function ReportThumbnail({ model, className }: { model: ThumbModel; className?: string }) {
  return (
    <div aria-hidden className={cn("relative overflow-hidden bg-muted", className)}>
      {model.rows > 0 ? (
        <div className="absolute inset-2.5">
          {model.cells.map((c, i) => <Cell key={i} c={c} rows={model.rows} />)}
        </div>
      ) : (
        <div className="absolute inset-2.5 flex flex-col gap-1.5 rounded-md border border-dashed border-border p-3">
          <Glyph g="text" />
        </div>
      )}
    </div>
  );
}
