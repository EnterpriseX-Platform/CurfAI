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
  ctx: { params?: Record<string, unknown>; row?: InterpolateRow }
): string {
  return template.replace(/\{\{\s*(param|row)\.([a-zA-Z0-9_]+)\s*\}\}/g, (_m, scope, key) => {
    const src = scope === "param" ? ctx.params : ctx.row;
    if (!src) return "";
    const v = src[key];
    return v == null ? "" : String(v);
  });
}
