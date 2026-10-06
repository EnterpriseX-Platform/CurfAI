/**
 * "Describe it" — the workspace's model writes a formula column from a
 * sentence ("profit on each order", "bulk if 5 or more units").
 *
 * The model is shown the column names and types and the functions a formula
 * may use — never a value from the table. What it writes is not trusted: it
 * goes through the same compiler every formula does (compileFormula) — run
 * inside the answer's schema, so a formula that fails gets generateStructured's
 * repair turn with the compiler's exact error before the person is told what
 * went wrong. A model can't get anything past that
 * check that a person typing couldn't.
 */
import { z } from "zod";
import { generateStructured } from "@/lib/agent/structured";
import { humanizeLlmError } from "@/lib/llm/humanizeError";
import { FormulaError, formulaRef } from "./parse";
import { formulaErrorText, type FormulaErrorParams } from "./messages";
import { compileFormula, FORMULA_FUNCTIONS, type FormulaColumn, type FormulaType } from "./compile";

export type FormulaSuggestion =
  | { ok: true; formula: string; name: string; explanation: string; type: FormulaType; uses: string[] }
  /** declined: the model said the columns can't give this (its reason is the error); invalid: it didn't manage a formula that checks out. */
  | { ok: false; code: "declined" | "invalid" | "failed"; error: string; key?: string; params?: FormulaErrorParams };

const MAX_ATTEMPTS = 2;

const SYSTEM = [
  "You write formulas for a new column in a data table, the way a spreadsheet user would. The person describes the column; you write the formula.",
  "",
  "The formula language — nothing else is accepted:",
  "- Column names exactly as listed. A name with spaces goes in [brackets], e.g. [unit cost].",
  "- Numbers (12, 0.5), text in double quotes (\"bulk\"; a \" inside is written \"\"), TRUE, FALSE, dates as \"YYYY-MM-DD\".",
  "- Operators: + - * / for numbers, & to join texts, = <> < > <= >= to compare. Parentheses group.",
  "- Functions:",
  ...Object.values(FORMULA_FUNCTIONS).map((f) => `  ${f.sig} — ${f.does}`),
  "",
  "Rules:",
  "- Never write SQL, and never use a function that isn't listed. TODAY(), NOW() and RAND() are not allowed: a column must give the same answer every time.",
  "- Text columns can't be used in arithmetic; use & to join text. For the days between two dates use DAYS(end_date, start_date).",
  "- Use only the columns listed. If the request needs something they don't have, don't approximate it — answer with formula null and say what's missing.",
  "- name: a short snake_case name for the new column, e.g. gross_profit.",
  "- explanation: one short sentence saying what the column holds, in the same language as the request.",
  "",
  'Answer with JSON only: {"formula": "…" | null, "name": "…", "explanation": "…", "reason": "only when formula is null"}',
].join("\n");

export async function suggestFormula(opts: {
  tenantId: string;
  userId: string | null;
  /** What the person wants the column to hold. */
  description: string;
  /** The table's columns — names and types only. */
  columns: FormulaColumn[];
  /** The request's; no repair starts once it fires. */
  signal?: AbortSignal;
}): Promise<FormulaSuggestion> {
  const description = opts.description.trim().slice(0, 500);
  if (!description) return { ok: false, code: "invalid", key: "suggest_empty", error: formulaErrorText("en", { key: "suggest_empty" }) };
  const columnList = opts.columns.map((c) => `- ${formulaRef(c.name)} (${c.type === "number" || c.type === "text" || c.type === "date" || c.type === "boolean" ? c.type : "any"})`).join("\n");

  // The compiler decides, inside the schema: a formula that doesn't check out
  // is an issue on `formula`, so the repair turn quotes the compiler's error.
  let lastProblem: { key: string; params: FormulaErrorParams; message: string } | null = null;
  const Answer = z.object({
    formula: z.string().nullable(),
    name: z.string().catch(""),
    explanation: z.string().catch(""),
    reason: z.string().catch(""),
  }).superRefine((v, ctx) => {
    if (v.formula === null) return;
    try {
      compileFormula(v.formula, { columns: opts.columns, dialect: "sqlite" });
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      lastProblem = { key: e.key, params: e.params, message: e.message };
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["formula"], message: e.message });
    }
  });

  const r = await generateStructured({
    tenantId: opts.tenantId, userId: opts.userId, kind: "suggest.formula",
    schema: Answer, system: SYSTEM,
    prompt: `Columns in this table:\n${columnList}\n\nThe new column: ${description}`,
    maxTokens: 600, temperature: 0.2, repairAttempts: MAX_ATTEMPTS - 1, signal: opts.signal,
    // "=A+B" as a spreadsheet user writes it, and an empty formula as none.
    normalise: (a) => {
      if (a && typeof a === "object" && typeof a.formula === "string") a.formula = a.formula.trim().replace(/^=\s*/, "") || null;
    },
  });
  if (!r.ok) {
    if (r.failureKind !== "invalid_shape") return { ok: false, code: "failed", error: humanizeLlmError(r.error).message };
    const p = lastProblem as { key: string; params: FormulaErrorParams; message: string } | null;
    // The key and params are the last formula problem's, for the editor to say in the reader's language.
    return p
      ? { ok: false, code: "invalid", error: `Couldn't write a formula that checks out: ${p.message}`, key: p.key, params: p.params }
      : { ok: false, code: "invalid", error: "Couldn't write a formula that checks out: the answer wasn't the JSON asked for." };
  }
  const answer = r.value;
  if (answer.formula === null) {
    return answer.reason
      ? { ok: false, code: "declined", error: answer.reason.slice(0, 300) }
      : { ok: false, code: "declined", key: "suggest_cant", error: formulaErrorText("en", { key: "suggest_cant" }) };
  }
  const compiled = compileFormula(answer.formula, { columns: opts.columns, dialect: "sqlite" });
  return {
    ok: true,
    formula: answer.formula,
    name: columnName(answer.name, description, opts.columns),
    explanation: answer.explanation.trim().slice(0, 300),
    type: compiled.type,
    uses: compiled.uses,
  };
}

/** A usable, unused column name: the model's if it's sensible, else one made from the description. */
export function columnName(suggested: string, description: string, columns: FormulaColumn[]): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "c_$1").slice(0, 50);
  const base = clean(suggested) || clean(description).split("_").slice(0, 4).join("_") || "new_column";
  const taken = new Set(columns.map((c) => c.name.toLowerCase()));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}
