/**
 * Pure template interpolation. No Node-only imports — safe to use in
 * client components and server components alike.
 *
 * Replaces {{param.foo}} and {{row.bar}} tokens in a string.
 * Intentionally minimal — no expressions, no function calls.
 */
export type InterpolateRow = Record<string, unknown>;

// Also exported here so client code can import the dataset type without
// transitively pulling in runner.ts (which imports better-sqlite3).
export type Row = Record<string, unknown>;
export type Dataset = Record<string, Row[]>;

export function interpolate(
  template: string,
  ctx: {
    params?: Record<string, unknown>;
    row?: InterpolateRow;
    /**
     * Text a reader sees may show a value differently (a Thai reader gets
     * "26 ก.ย. 2569" for a date param — see thaiDateLabel). Return null to
     * keep String(v). Machine callers (action configs, Operate payloads)
     * never pass this, so they always get the raw value.
     */
    display?: (v: unknown) => string | null;
  }
): string {
  return template.replace(/\{\{\s*(param|row)\.([a-zA-Z0-9_]+)\s*\}\}/g, (_m, scope, key) => {
    const src = scope === "param" ? ctx.params : ctx.row;
    if (!src) return "";
    const v = src[key];
    if (v == null) return "";
    return ctx.display?.(v) ?? String(v);
  });
}
