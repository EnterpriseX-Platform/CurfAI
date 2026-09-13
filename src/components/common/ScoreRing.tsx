/**
 * Small circular percentage ring — e.g. the per-dashboard health score on
 * the Interactive Dashboard hub grid. Plain stroke-dasharray SVG, no chart
 * library; colors come straight from Tailwind utility classes (same
 * convention as TemplateGallery's ACCENT map) since this is an app-shell
 * page, not a report block — resolveTheme() doesn't apply here.
 */
const RADIUS = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ScoreRing({ value, size = 44 }: { value: number; size?: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const tone =
    clamped >= 85 ? "text-success" :
    clamped >= 60 ? "text-warning" :
    "text-destructive";
  const offset = CIRCUMFERENCE * (1 - clamped / 100);

  return (
    <svg width={size} height={size} viewBox="0 0 36 36" className="shrink-0" role="img" aria-label={`${clamped}`}>
      <circle cx="18" cy="18" r={RADIUS} fill="none" strokeWidth="3.5" className="stroke-border/60" />
      <circle
        cx="18" cy="18" r={RADIUS} fill="none" strokeWidth="3.5" strokeLinecap="round"
        stroke="currentColor"
        className={tone}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={offset}
        transform="rotate(-90 18 18)"
        style={{ transition: "stroke-dashoffset 300ms ease" }}
      />
      <text x="18" y="19.5" textAnchor="middle" dominantBaseline="middle" className="fill-foreground text-[10px] font-semibold tabular-nums">
        {clamped}
      </text>
    </svg>
  );
}
