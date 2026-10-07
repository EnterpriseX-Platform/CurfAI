/**
 * What a person holds for the engine's row rules, as pure data: validation, grouping, and comparing Curf's copy
 * with the engine's. No database and no network here, so every rule is tested directly (attributeModel.test.ts).
 *
 * The engine's entitlement API REPLACES: an entry {subject, attribute, values} sets everything that subject holds
 * for that attribute, and an empty list removes it. So reconciling is never "apply the difference": for every
 * (subject, attribute) pair that differs, send Curf's complete set for it.
 */

/** The engine's own rules (engines/contracts/engine-v1.openapi.yaml, EntitlementEntry). */
export const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const ATTRIBUTE_VALUE_MAX_LENGTH = 200;
export const ATTRIBUTE_VALUES_MAX = 1000;
export const ENTITLEMENT_BATCH_SIZE = 500;
export const SUBJECT_MAX_LENGTH = 255;

export type EntitlementRow = { subject: string; attribute: string; value: string };
export type EntitlementEntry = { subject: string; attribute: string; values: string[] };

export function isValidAttributeName(name: unknown): name is string {
  return typeof name === "string" && ATTRIBUTE_NAME_PATTERN.test(name);
}

/**
 * Values as they will be stored: trimmed, no empty ones, no duplicates, in the order given. Control characters
 * are refused (a value is a code someone typed or imported, and ends up in the engine's tables and logs).
 */
export function normaliseValues(input: unknown): { ok: true; values: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "Values must be a list." };
  const seen = new Set<string>();
  const values: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string" && typeof raw !== "number") return { ok: false, error: "Each value must be text." };
    const value = String(raw).trim();
    if (!value) continue;
    if (value.length > ATTRIBUTE_VALUE_MAX_LENGTH) return { ok: false, error: `A value can be at most ${ATTRIBUTE_VALUE_MAX_LENGTH} characters.` };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: "A value cannot contain control characters." };
    if (!seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  if (values.length > ATTRIBUTE_VALUES_MAX) return { ok: false, error: `A person can hold at most ${ATTRIBUTE_VALUES_MAX} values for one attribute.` };
  return { ok: true, values };
}

const pairKey = (subject: string, attribute: string) => `${subject}\u0000${attribute}`;

/** Rows grouped by (subject, attribute), each value once, order kept. */
export function groupByPair(rows: EntitlementRow[]): Map<string, { subject: string; attribute: string; values: string[] }> {
  const out = new Map<string, { subject: string; attribute: string; values: string[] }>();
  for (const row of rows) {
    const key = pairKey(row.subject, row.attribute);
    const entry = out.get(key) ?? { subject: row.subject, attribute: row.attribute, values: [] };
    if (!entry.values.includes(row.value)) entry.values.push(row.value);
    out.set(key, entry);
  }
  return out;
}

/**
 * The entries that make the engine hold exactly what Curf holds, for the pairs where they differ. A pair the
 * engine has and Curf does not becomes an entry with no values (the engine removes it). Pairs that already match
 * produce nothing, so a full reconcile of an unchanged workspace sends nothing.
 */
export function reconcileEntries(curf: EntitlementRow[], engine: EntitlementRow[]): EntitlementEntry[] {
  const mine = groupByPair(curf);
  const theirs = groupByPair(engine);
  const entries: EntitlementEntry[] = [];
  for (const [key, want] of mine) {
    const have = theirs.get(key)?.values ?? [];
    if (!sameSet(want.values, have)) entries.push({ subject: want.subject, attribute: want.attribute, values: [...want.values] });
  }
  for (const [key, have] of theirs) {
    if (!mine.has(key) && have.values.length > 0) entries.push({ subject: have.subject, attribute: have.attribute, values: [] });
  }
  return entries;
}

export type Drift = {
  inSync: boolean;
  /** Held in Curf, not on the engine: the person gets less than they should (no rows). */
  missingOnEngine: EntitlementRow[];
  /** Held on the engine, not in Curf: the person may see rows Curf would not give them. */
  extraOnEngine: EntitlementRow[];
};

export function driftBetween(curf: EntitlementRow[], engine: EntitlementRow[]): Drift {
  const key = (r: EntitlementRow) => `${pairKey(r.subject, r.attribute)}\u0000${r.value}`;
  const has = new Set(curf.map(key));
  const there = new Set(engine.map(key));
  const missingOnEngine = dedupe(curf).filter((r) => !there.has(key(r)));
  const extraOnEngine = dedupe(engine).filter((r) => !has.has(key(r)));
  return { inSync: missingOnEngine.length === 0 && extraOnEngine.length === 0, missingOnEngine, extraOnEngine };

  function dedupe(rows: EntitlementRow[]): EntitlementRow[] {
    const seen = new Set<string>();
    return rows.filter((r) => (seen.has(key(r)) ? false : (seen.add(key(r)), true)));
  }
}

/** Entries in groups the engine accepts in one call. */
export function inBatches<T>(items: T[], size = ENTITLEMENT_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((v) => set.has(v));
}

/** Rows from a table of people for an import: groups "email, attribute, value" lines into one set per person and name. */
export function groupImport(
  rows: Array<{ email: string; name: string; value: string }>,
): { ok: true; sets: Array<{ email: string; name: string; values: string[] }> } | { ok: false; error: string; row: number } {
  const sets = new Map<string, { email: string; name: string; values: string[] }>();
  for (let i = 0; i < rows.length; i++) {
    const email = String(rows[i].email ?? "").trim().toLowerCase();
    const name = String(rows[i].name ?? "").trim();
    if (!email || !email.includes("@")) return { ok: false, error: "Each row needs the person's email address.", row: i + 1 };
    if (!isValidAttributeName(name)) return { ok: false, error: "An attribute name starts with a letter and uses letters, digits and underscores.", row: i + 1 };
    const key = `${email}\u0000${name}`;
    const set = sets.get(key) ?? { email, name, values: [] };
    set.values.push(String(rows[i].value ?? ""));
    sets.set(key, set);
  }
  const out: Array<{ email: string; name: string; values: string[] }> = [];
  for (const set of sets.values()) {
    const normal = normaliseValues(set.values);
    if (!normal.ok) return { ok: false, error: normal.error, row: 0 };
    out.push({ ...set, values: normal.values });
  }
  return { ok: true, sets: out };
}
