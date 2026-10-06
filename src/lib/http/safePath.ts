/**
 * A destination the app may send someone to after sign-in: a path on this
 * site only. Another origin, a protocol-relative "//host", a backslash form
 * browsers read the same way, a control character, or any scheme falls back.
 * Pure — safe to import from client components.
 */
export function sameSitePath(v: string | null | undefined, fallback = "/"): string {
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//")) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(v)) return fallback;
  return v;
}
