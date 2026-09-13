/**
 * Tiny cron predicate: does a cron expression match this Date (minute precision)?
 * Supports every-minute, every-N, comma lists,, exact numbers, and "a-b" ranges for the five
 * standard fields: minute hour dom mon dow.
 *
 * Not a full spec — good enough for the patterns Curf Schedules use in practice.
 */
export function cronMatches(expr: string, d: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const minute = d.getUTCMinutes();
  const hour = d.getUTCHours();
  const dom = d.getUTCDate();
  const mon = d.getUTCMonth() + 1;
  const dow = d.getUTCDay(); // Sun=0..Sat=6
  return (
    fieldMatches(parts[0]!, minute, 0, 59) &&
    fieldMatches(parts[1]!, hour, 0, 23) &&
    fieldMatches(parts[2]!, dom, 1, 31) &&
    fieldMatches(parts[3]!, mon, 1, 12) &&
    fieldMatches(parts[4]!, dow, 0, 6)
  );
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  for (const piece of field.split(",")) {
    if (piece === "*") return true;
    const stepMatch = /^(\*|(\d+)-(\d+))\/(\d+)$/.exec(piece);
    if (stepMatch) {
      const step = parseInt(stepMatch[4]!, 10);
      const lo = stepMatch[2] ? parseInt(stepMatch[2]!, 10) : min;
      const hi = stepMatch[3] ? parseInt(stepMatch[3]!, 10) : max;
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      continue;
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(piece);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1]!, 10);
      const hi = parseInt(rangeMatch[2]!, 10);
      if (value >= lo && value <= hi) return true;
      continue;
    }
    if (piece === String(value)) return true;
  }
  return false;
}
