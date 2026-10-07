/** Puts values into a translated sentence: fill("{n} views", { n: 3 }) -> "3 views". A placeholder with no value is left as it is. */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}
