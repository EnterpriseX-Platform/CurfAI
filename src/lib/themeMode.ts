/**
 * App-wide light / dark mode.
 *
 * The preference is `User.preferencesJson.mode` — "light", "dark" or "auto"
 * (chosen on /account, default "auto"). Every token in globals.css flips
 * under `.dark`, and "auto" follows the OS through a `prefers-color-scheme`
 * block there, so:
 *
 *   - "auto" stamps nothing on <html>: the default state needs no DOM
 *     mutation before hydration, and the page follows the OS live.
 *   - "dark" / "light" stamp that class on <html> before first paint (see
 *     ThemeModeBoot) — `.light` exists only to override the OS block.
 *
 * Components never need `dark:` variants: they take colours from the tokens.
 * This module is isomorphic; the DB read lives in ThemeModeBoot.
 */
export type ThemeMode = "light" | "dark" | "auto";

export function parseThemeMode(preferencesJson: string | null | undefined): ThemeMode {
  try {
    const m = JSON.parse(preferencesJson || "{}")?.mode;
    return m === "light" || m === "dark" ? m : "auto";
  } catch {
    return "auto";
  }
}

/** One-line inline script: runs before hydration, so a dark user never sees a light flash. */
export function themeModeBootScript(mode: ThemeMode): string {
  return `(function(m){var c=document.documentElement.classList;c.remove("dark","light");if(m==="dark"||m==="light")c.add(m);})(${JSON.stringify(mode)});`;
}

/** Client-side: apply a freshly chosen mode without a reload. */
export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const c = document.documentElement.classList;
  c.remove("dark", "light");
  if (mode === "dark" || mode === "light") c.add(mode);
}
