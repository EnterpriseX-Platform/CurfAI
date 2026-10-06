/**
 * `{name}` placeholders in a dictionary string, filled from `params`; one
 * left without a value stays as written. For messages that come from the
 * server as a key plus its parts (a run's log, a refused action, a sheet
 * error), so the page says them in the reader's language. Pure.
 */
export function fill(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/**
 * `t(key)` filled from `params` — or `otherwise` when the dictionary doesn't
 * have the key (t hands the key back), so a message from a newer server, or
 * one sent without a key, still reads.
 */
export function translated(t: (key: string) => string, key: string | undefined, params: Record<string, string | number> | undefined, otherwise: string): string {
  if (!key) return otherwise;
  const s = t(key);
  return s && s !== key ? fill(s, params) : otherwise;
}
