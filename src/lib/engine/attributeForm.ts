/**
 * The edit-a-person dialog's rules, the same as the server's (attributeModel.ts), as codes the page translates.
 * Pure and client-safe.
 */
import { ATTRIBUTE_VALUES_MAX, ATTRIBUTE_VALUE_MAX_LENGTH, isValidAttributeName } from "./attributeModel";

export type FormError = { code: "nameRequired" | "nameInvalid" | "valueTooLong" | "valueControl" | "tooManyValues"; params?: Record<string, string | number> };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Text typed or pasted into the values box: separated by new lines or commas; blanks and repeats dropped. */
export function splitValueInput(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\n\r,]+/)) {
    const value = part.trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** The values a person holds plus newly typed ones, each once, in order. */
export function addValues(existing: string[], typed: string): string[] {
  const out = [...existing];
  for (const value of splitValueInput(typed)) if (!out.includes(value)) out.push(value);
  return out;
}

export function removeValue(values: string[], value: string): string[] {
  return values.filter((v) => v !== value);
}

export function validateName(name: string): FormError | null {
  const trimmed = name.trim();
  if (!trimmed) return { code: "nameRequired" };
  return isValidAttributeName(trimmed) ? null : { code: "nameInvalid" };
}

/** The first problem with a single value, or null. */
export function validateValue(value: string): FormError | null {
  if (value.length > ATTRIBUTE_VALUE_MAX_LENGTH) return { code: "valueTooLong", params: { max: ATTRIBUTE_VALUE_MAX_LENGTH } };
  if (CONTROL.test(value)) return { code: "valueControl" };
  return null;
}

export function validateValues(values: string[]): FormError | null {
  for (const value of values) {
    const bad = validateValue(value);
    if (bad) return bad;
  }
  if (values.length > ATTRIBUTE_VALUES_MAX) return { code: "tooManyValues", params: { max: ATTRIBUTE_VALUES_MAX } };
  return null;
}

export type EditCheck =
  | { ok: true; name: string; values: string[] }
  | { ok: false; name: FormError | null; values: FormError | null };

/** Everything the dialog can check before it asks the server. An empty list is allowed: it removes the attribute. */
export function checkEdit(input: { name: string; values: string[] }): EditCheck {
  const name = validateName(input.name);
  const values = validateValues(input.values);
  if (name || values) return { ok: false, name, values };
  return { ok: true, name: input.name.trim(), values: input.values };
}

/** Known attribute names that start with what was typed (case-insensitive), never the exact match itself. */
export function suggestNames(known: string[], typed: string, limit = 8): string[] {
  const q = typed.trim().toLowerCase();
  const hits = known.filter((n) => n.toLowerCase().startsWith(q) && n.toLowerCase() !== q);
  return hits.slice(0, limit);
}

export function diffValues(before: string[], after: string[]): { added: string[]; removed: string[] } {
  return { added: after.filter((v) => !before.includes(v)), removed: before.filter((v) => !after.includes(v)) };
}
