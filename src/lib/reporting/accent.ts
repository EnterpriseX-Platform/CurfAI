/**
 * Pure accent-colour math for the public app surfaces (`/apps/[slug]`).
 *
 * No `"use client"` here on purpose — `page.tsx` is a Server Component
 * (it builds `accentPalette` for the report renderer), and `PublicAppShell`
 * is a Client Component (it needs the bar's ink for inline styles). Both
 * need the exact same colour decisions, so the math lives in a plain
 * module either side can import instead of being trapped behind a client
 * boundary. `PublicAppShell` re-exports `accentInk`/`accentSoft` so
 * existing client imports (`AppCopilot.tsx`) keep working unchanged.
 */

/**
 * Black or white, whichever stays legible on `hex`.
 *
 * The prototype could hardcode white text because its accent was a fixed
 * dark green; accentColor here is tenant-supplied, so a pale brand would
 * otherwise render white-on-white. Rec. 601 luma at the usual 0.6 cut,
 * biased so anything ambiguous keeps white (brand colours skew dark, and
 * white is the look the prototype establishes).
 */
export type AccentInk = {
  /** Body text on the bar. */ fg: string;
  /** De-emphasised text (subtitle, inactive tabs). */ soft: string;
  /** Hairlines and outlines. */ line: string;
  /** Filled surfaces on the bar — monogram, active tab. */ chip: string;
};

/** Exported so other accent-coloured surfaces (e.g. the copilot's own
 *  message bubble) make the same light/dark ink call this bar already
 *  does, instead of a second luma calculation drifting from this one. */
export function accentInk(hex: string): AccentInk {
  const onDark: AccentInk = {
    fg: "#ffffff",
    soft: "rgba(255,255,255,.75)",
    line: "rgba(255,255,255,.30)",
    chip: "rgba(255,255,255,.18)",
  };
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return onDark;
  const n = parseInt(m[1], 16);
  const luma = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luma > 0.6
    ? { fg: "#141413", soft: "rgba(20,20,19,.70)", line: "rgba(20,20,19,.25)", chip: "rgba(20,20,19,.10)" }
    : onDark;
}

/**
 * A translucent tint of the app's own accent (~12% alpha) — for hover and
 * selected states in body content (list-row selection rings, status
 * borders) that want to read as "this app's colour" without the full-
 * strength bar fill. Exported alongside accentInk so every accent-aware
 * surface derives its tones from the same two functions instead of a third
 * ad hoc calculation.
 */
export function accentSoft(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  // Same default indigo the bar itself falls back to (see PublicAppShell's
  // own default) — not a new raw palette value, just this file's existing
  // default in rgba() form.
  if (!m) return "rgba(99,102,241,.12)";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},.12)`;
}

/**
 * A solid-hex tint/shade of `hex` by `pct` (roughly -1..1), per channel:
 * `c + (target - c) * |pct|`. Positive `pct` lightens toward white — the
 * safe direction on both light and dark grounds, since it drops saturation
 * without ever dropping contrast on either. Negative `pct` shades toward
 * `#141413`, the same dark ink `accentInk` already switches text to for a
 * pale accent, rather than toward pure black.
 *
 * Used for chart series 2/3 (`accentTint(accent, .35)`, `.65`) so a report
 * with no tenant-written custom palette still reads as "this app's colour,
 * varied" instead of falling back to a generic series palette. Returns hex
 * (not rgba) because both call sites — SVG gradient `stopColor` and
 * `TableBlock.tsx`'s bar fills — parse a hex string, not rgba().
 */
export function accentTint(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const target = pct >= 0 ? [0xff, 0xff, 0xff] : [0x14, 0x14, 0x13];
  const p = Math.min(1, Math.abs(pct));
  const mixed = channels.map((c, i) => Math.round(c + (target[i] - c) * p));
  return "#" + mixed.map((c) => c.toString(16).padStart(2, "0")).join("");
}
