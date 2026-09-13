/**
 * Safe JSON parsing for untrusted input that will be merged into a plain
 * object with Object.assign() / a spread (OWASP A08:2025 — deserialization).
 *
 * Plain JSON.parse() alone is NOT the vulnerable step — a "__proto__" key
 * comes back as an ordinary own string-keyed property, and object-literal
 * spread (`{...parsed}`) copies only own properties without invoking any
 * setter, so it's unaffected. `Object.assign(target, parsed)` is the
 * dangerous case: for the specific key "__proto__", Object.assign's
 * internal [[Set]] semantics reach `Object.prototype`'s real `__proto__`
 * accessor, which reassigns `target`'s own prototype to whatever the
 * attacker supplied — verified empirically, not assumed. That doesn't
 * pollute the shared `Object.prototype` itself, but it does let an
 * attacker forge arbitrary inherited properties onto that one object,
 * which downstream code that reads properties directly (not via
 * hasOwnProperty) can't distinguish from real data.
 *
 * Use this instead of JSON.parse() wherever the parsed result will be fed
 * into Object.assign() (or any other API with the same [[Set]] semantics)
 * against a plain object, and the JSON text comes from something a tenant
 * user controls (stored request payloads, imported files, etc).
 */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(text, (key, value) => (key === "__proto__" ? undefined : value));
}
