/** Shape pushed onto the cron tick's `fired` array — one entry per thing the tick did. */
export type FiredItem = { id: string; kind: string; status: string; narrative?: string };

/** JSON.parse that returns null instead of throwing — schedule rows store optional JSON columns. */
export function safeParseJson<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}
