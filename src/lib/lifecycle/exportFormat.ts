/**
 * Pure helpers for the workspace export (lib/lifecycle/export.ts): CSV lines, the formula-injection guard, and removing
 * secrets from configuration blobs.
 */
export const EXPORT_FORMAT = "curf-workspace-export/1";

/** One CSV record, quoted where a value needs it, ending in a newline. Values are written as stored. */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === "bigint") s = v.toString();
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: unknown[]): string {
  return values.map(csvField).join(",") + "\r\n";
}

/** A spreadsheet runs a cell that starts with = + - @ (or a tab/CR) as a formula; a leading quote keeps it text. */
export function safeCell(v: string | null | undefined): string {
  const s = v ?? "";
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

const SECRET_KEY = /secret|token|password|passwd|authorization|api[-_]?key|signing|credential|bearer|webhook|(^|[-_])url$|(^|[-_])key$/i;

/** A copy of a JSON value with every value under a secret-looking key replaced by "[redacted]", at any depth. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[redacted]";
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && v !== "" ? "[redacted]" : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}
