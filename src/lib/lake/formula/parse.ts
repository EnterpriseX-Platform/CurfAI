/**
 * Formula columns — the language a person writes, spreadsheet-style:
 *
 *   revenue * margin_pct            ROUND(unit_price * qty, 2)
 *   IF(qty >= 5, "bulk", "single")  region & " · " & store
 *   [unit price] * 1.07             DAYS(shipped_date, order_date)
 *
 * This file turns the text into a tree and nothing else: numbers, "text"
 * (a " inside is written ""), TRUE / FALSE, column names (bare, or in
 * [brackets] when they hold spaces), function calls, + - * / & and the
 * comparisons = <> < > <= >=, with the usual precedence. Every node keeps
 * where it came from, so an error can point at it. What the names mean —
 * which columns exist, which functions, what types — is compile.ts.
 *
 * A formula never reaches a database as written. compile.ts builds the SQL
 * from this tree, quoting every name itself; there is no path from the
 * formula's text to the query.
 */
import { FORMULA_ERRORS, formulaErrorText, type FormulaErrorKey, type FormulaErrorParams } from "./messages";

export type Node =
  | { k: "num"; v: string; at: number }
  | { k: "str"; v: string; at: number }
  | { k: "bool"; v: boolean; at: number }
  | { k: "col"; name: string; at: number; len: number }
  | { k: "call"; fn: string; args: Node[]; at: number; len: number }
  | { k: "neg"; a: Node; at: number }
  | { k: "bin"; op: BinOp; a: Node; b: Node; at: number };

export type BinOp = "+" | "-" | "*" | "/" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=";

/**
 * A formula that can't be used, and where: `at` is a 0-based index into the
 * text. `key` and `params` say which error, for showing it in the reader's
 * language (messages.ts); `message` is the English; `code` the kind of error.
 */
export class FormulaError extends Error {
  readonly code: string;
  constructor(readonly key: FormulaErrorKey, readonly at: number, readonly params: FormulaErrorParams = {}) {
    super(formulaErrorText("en", { key, params }));
    this.code = FORMULA_ERRORS[key].code;
  }
}

export const MAX_FORMULA_LENGTH = 1000;
const MAX_DEPTH = 40;

type Tok =
  | { t: "num"; v: string; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "id"; v: string; at: number; len: number; bracketed: boolean }
  | { t: "op"; v: BinOp; at: number }
  | { t: "(" | ")" | ","; at: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      const s = src.slice(i, j);
      if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) throw new FormulaError("bad_number", i, { text: s });
      out.push({ t: "num", v: s, at: i });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      for (;;) {
        if (j >= src.length) throw new FormulaError("open_text", i);
        if (src[j] === '"') {
          if (src[j + 1] === '"') { s += '"'; j += 2; continue; }
          break;
        }
        s += src[j];
        j++;
      }
      out.push({ t: "str", v: s, at: i });
      i = j + 1;
      continue;
    }
    if (c === "[") {
      const j = src.indexOf("]", i);
      if (j < 0) throw new FormulaError("open_bracket", i);
      const name = src.slice(i + 1, j).trim();
      if (!name) throw new FormulaError("empty_bracket", i);
      out.push({ t: "id", v: name, at: i, len: j + 1 - i, bracketed: true });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_฀-๿]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_฀-๿]/.test(src[j]!)) j++;
      out.push({ t: "id", v: src.slice(i, j), at: i, len: j - i, bracketed: false });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>" || two === "!=") {
      out.push({ t: "op", v: two === "!=" ? "<>" : two, at: i });
      i += 2;
      continue;
    }
    if ("+-*/&=<>".includes(c)) { out.push({ t: "op", v: c as BinOp, at: i }); i++; continue; }
    if (c === "(" || c === ")" || c === ",") { out.push({ t: c, at: i }); i++; continue; }
    throw new FormulaError("bad_char", i, { char: c });
  }
  return out;
}

/**
 * The formula with every reference to column `from` renamed `to` — for when a
 * column is renamed, so the formulas that read it keep reading it. Function
 * names and anything inside quotes are left alone. Works on tokens, so a
 * formula that no longer checks out still follows the rename; one that can't
 * even be split into tokens (an unclosed quote) is returned as it was.
 */
/**
 * How a formula refers to a column: bare when the language reads the name as
 * one (letters, digits, _ and Thai, not TRUE or FALSE), in [brackets]
 * otherwise. The editor's column chips, the AI writer's column list and a
 * rename all write references with it, so none of them can disagree with
 * the parser (audit 2026-09-30, C6: "unit-price" went to the model bare and
 * read as unit minus price).
 */
export function formulaRef(name: string): string {
  return /^[A-Za-z_฀-๿][A-Za-z0-9_฀-๿]*$/.test(name) && !/^(TRUE|FALSE)$/i.test(name) ? name : `[${name}]`;
}

export function renameColumnInFormula(src: string, from: string, to: string): string {
  let toks: Tok[];
  try { toks = tokenize(src); } catch { return src; }
  const ref = formulaRef(to);
  let out = src;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i]!;
    if (t.t !== "id") continue;
    const next = toks[i + 1];
    if (!t.bracketed && next && next.t === "(") continue;
    if (!t.bracketed && /^(TRUE|FALSE)$/i.test(t.v)) continue;
    if (t.v.toLowerCase() !== from.toLowerCase()) continue;
    out = out.slice(0, t.at) + ref + out.slice(t.at + t.len);
  }
  return out;
}

/** Loosest to tightest. */
const LEVELS: BinOp[][] = [["=", "<>", "<", ">", "<=", ">="], ["&"], ["+", "-"], ["*", "/"]];

export function parseFormula(src: string): Node {
  if (src.length > MAX_FORMULA_LENGTH) {
    throw new FormulaError("too_long", MAX_FORMULA_LENGTH, { max: MAX_FORMULA_LENGTH });
  }
  const toks = tokenize(src);
  if (toks.length === 0) throw new FormulaError("empty", 0);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const deeper = (at: number) => {
    if (++depth > MAX_DEPTH) throw new FormulaError("too_deep", at);
  };

  function binary(level: number): Node {
    if (level === LEVELS.length) return unary();
    let left = binary(level + 1);
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op" || !LEVELS[level]!.includes(t.v)) return left;
      p++;
      left = { k: "bin", op: t.v, a: left, b: binary(level + 1), at: t.at };
    }
  }

  function unary(): Node {
    const t = peek();
    if (t && t.t === "op" && t.v === "-") {
      p++;
      deeper(t.at);
      const a = unary();
      depth--;
      return { k: "neg", a, at: t.at };
    }
    return atom();
  }

  function atom(): Node {
    const t = toks[p++];
    if (!t) throw new FormulaError("ends_early", src.length);
    if (t.t === "num") return { k: "num", v: t.v, at: t.at };
    if (t.t === "str") return { k: "str", v: t.v, at: t.at };
    if (t.t === "(") {
      deeper(t.at);
      const e = binary(0);
      depth--;
      closeParen();
      return e;
    }
    if (t.t === "id") {
      const next = peek();
      if (!t.bracketed && next && next.t === "(") {
        p++;
        deeper(t.at);
        const args: Node[] = [];
        if (!(peek() && peek()!.t === ")")) {
          args.push(binary(0));
          while (peek() && peek()!.t === ",") { p++; args.push(binary(0)); }
        }
        depth--;
        const close = closeParen();
        return { k: "call", fn: t.v.toUpperCase(), args, at: t.at, len: close + 1 - t.at };
      }
      if (!t.bracketed && (t.v.toUpperCase() === "TRUE" || t.v.toUpperCase() === "FALSE")) {
        return { k: "bool", v: t.v.toUpperCase() === "TRUE", at: t.at };
      }
      return { k: "col", name: t.v, at: t.at, len: t.len };
    }
    if (t.t === ")") throw new FormulaError("stray_paren", t.at);
    if (t.t === ",") throw new FormulaError("stray_comma", t.at);
    throw new FormulaError("stray_operator", t.at, { op: t.t === "op" ? t.v : t.t });
  }

  function closeParen(): number {
    const t = toks[p++];
    if (!t) throw new FormulaError("open_paren", src.length);
    if (t.t !== ")") throw new FormulaError(t.t === "," ? "open_paren_values" : "open_paren_operator", t.at);
    return t.at;
  }

  const root = binary(0);
  if (p < toks.length) {
    const t = toks[p]!;
    const what = t.t === "op" || t.t === "num" || t.t === "str" ? `"${t.v}"` : t.t === "id" ? t.v : `"${t.t}"`;
    throw new FormulaError("unexpected", t.at, { what });
  }
  return root;
}
