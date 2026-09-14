"use client";
/**
 * Auto-generated mini preview for a template — renders the template's first
 * page as a tiny SVG showing block positions and types color-coded.
 *
 * Avoids shipping static PNGs: the preview stays in sync as templates evolve.
 *
 * One restrained palette everywhere — greyscale blocks with a single primary
 * accent for chart bars and KPI numbers — so a thumbnail reads as a small
 * document, not a colour swatch. The product gallery and the marketing
 * teaser share it; a block's type shows in its shape, not its hue.
 */
import type { Block } from "@/lib/reporting/schema";

const COLORS: Record<string, { fill: string; stroke: string; accent?: string }> = {
  title:     { fill: "#1f2937", stroke: "#111827" },
  text:      { fill: "#f3f4f6", stroke: "#e5e7eb" },
  kpi:       { fill: "#f9fafb", stroke: "#e5e7eb", accent: "#4f46e5" },
  chart:     { fill: "#f9fafb", stroke: "#e5e7eb", accent: "#4f46e5" },
  table:     { fill: "#f9fafb", stroke: "#e5e7eb", accent: "#6b7280" },
  image:     { fill: "#f3f4f6", stroke: "#e5e7eb", accent: "#9ca3af" },
  divider:   { fill: "#f3f4f6", stroke: "#e5e7eb" },
  pageBreak: { fill: "#f9fafb", stroke: "#e5e7eb" },
};

export function TemplateThumbnail({ blocks }: { blocks: Block[] }) {
  // 12 column × 24 row logical space. Pick tallest block to set viewBox height.
  const cols = 12;
  const rows = Math.max(20, blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0) + 1);
  const W = 180, H = Math.round((rows / cols) * W * 0.85);

  return (
    <svg
      viewBox={`0 0 ${cols} ${rows}`}
      width={W} height={H}
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid meet"
      className="mx-auto block h-full w-full rounded-md"
      aria-hidden
    >
      {/* paper bg */}
      <rect x={0} y={0} width={cols} height={rows} fill="#ffffff" />

      {blocks.map((b) => {
        const c = COLORS[b.type] ?? COLORS.text;
        return (
          <g key={b.id}>
            <rect
              x={b.x + 0.15} y={b.y + 0.15}
              width={Math.max(0.1, b.w - 0.3)} height={Math.max(0.1, b.h - 0.3)}
              rx={0.25} ry={0.25}
              fill={c.fill} stroke={c.stroke} strokeWidth={0.08}
            />
            {renderDetail(b, c.accent)}
          </g>
        );
      })}
    </svg>
  );
}

function renderDetail(b: Block, accent?: string) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const left = b.x + 0.4;
  const inset = 0.35;

  if (b.type === "title") {
    return (
      <g>
        <rect x={left} y={b.y + 0.5} width={Math.min(b.w * 0.6, b.w - 0.8)} height={0.25} fill="#ffffff" rx={0.08} />
        {b.h > 1.3 && <rect x={left} y={b.y + 0.9} width={Math.min(b.w * 0.35, b.w - 0.8)} height={0.14} fill="#9ca3af" rx={0.08} />}
      </g>
    );
  }
  if (b.type === "kpi") {
    return (
      <g>
        <rect x={left} y={b.y + 0.5} width={Math.max(0.1, b.w * 0.45)} height={0.2} fill={accent} opacity={0.6} rx={0.08} />
        <rect x={left} y={b.y + 0.95} width={Math.max(0.1, b.w * 0.7)} height={0.55} fill={accent} rx={0.1} />
      </g>
    );
  }
  if (b.type === "chart") {
    // mini bar chart
    const bars = 5;
    const bw = (b.w - inset * 2) / bars - 0.08;
    return (
      <g>
        {Array.from({ length: bars }, (_, i) => {
          const bh = 0.4 + Math.abs(Math.sin((i + 1) * 1.3)) * (b.h - 1.2);
          return (
            <rect
              key={i}
              x={b.x + inset + i * (bw + 0.08)}
              y={b.y + b.h - inset - bh}
              width={bw}
              height={bh}
              fill={accent}
              rx={0.04}
            />
          );
        })}
      </g>
    );
  }
  if (b.type === "table") {
    const rowH = 0.45;
    const rows = Math.max(1, Math.floor((b.h - 0.8) / rowH));
    return (
      <g>
        <rect x={left} y={b.y + 0.4} width={b.w - 0.8} height={0.35} fill={accent} opacity={0.3} rx={0.05} />
        {Array.from({ length: Math.min(rows, 6) }, (_, i) => (
          <line
            key={i}
            x1={left} y1={b.y + 0.9 + (i + 1) * rowH * 0.7}
            x2={b.x + b.w - 0.4} y2={b.y + 0.9 + (i + 1) * rowH * 0.7}
            stroke="#e5e7eb" strokeWidth={0.06}
          />
        ))}
      </g>
    );
  }
  if (b.type === "divider") {
    return <line x1={b.x + 0.4} y1={cy} x2={b.x + b.w - 0.4} y2={cy} stroke="#9ca3af" strokeWidth={0.06} />;
  }
  return null;
}
