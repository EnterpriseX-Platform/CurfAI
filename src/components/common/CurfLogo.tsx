/**
 * Curf brand mark.
 *
 * The icon is a "Rising C" — a C-shape whose lower terminal extends upward-and-right
 * into a data-point dot. Works at any size from favicon (16px) to billboard.
 *
 * variant="lockup"    → icon + lowercase wordmark (primary use)
 * variant="icon"      → icon only (app icon, favicon, tight spaces)
 * variant="wordmark"  → wordmark only (dense contexts where the mark would compete)
 *
 * Pass `mono` for single-color rendering (inherits currentColor).
 */
import { cn } from "@/lib/utils";

type Variant = "icon" | "wordmark" | "lockup";

export function CurfLogo({
  variant = "lockup",
  size = 28,
  className,
  mono = false,
}: {
  variant?: Variant;
  size?: number;
  className?: string;
  mono?: boolean;
}) {
  const stroke = mono ? "currentColor" : "hsl(var(--primary))";
  const fontSize = Math.round(size * 0.78);

  if (variant === "wordmark") {
    return (
      <span
        className={cn("inline-flex items-baseline font-semibold tracking-tight", className)}
        style={{ fontSize, letterSpacing: "-0.03em" }}
      >
        curf
      </span>
    );
  }

  const icon = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M 28 10 A 11 11 0 1 0 28 30 L 34 22"
        fill="none"
        stroke={stroke}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="34" cy="22" r="2.6" fill={stroke} />
    </svg>
  );

  if (variant === "icon") {
    return <span className={cn("inline-flex", className)}>{icon}</span>;
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      {icon}
      <span
        className="font-semibold tracking-tight leading-none"
        style={{ fontSize, letterSpacing: "-0.03em" }}
      >
        curf
      </span>
    </span>
  );
}
