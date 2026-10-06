/**
 * Formula columns in a lake table (the SQLite engine; DuckDB's counterpart
 * is in engine/duckdbWrite.ts).
 *
 * Each is a live VIRTUAL generated column — the engine works it out as a row
 * is read, so rows that arrive later have it too, with nothing to keep in
 * step on writes. The formula as the person wrote it travels with the data,
 * in the table's own __lake_meta config (FORMULAS_KEY), so a backup, a
 * branch, a restore or an engine migration carries it; and every path that
 * rebuilds a table from scratch puts its formulas back (reapplyFormulas).
 *
 * The schema catalog (LakeTable.schemaJson) shows them with a `formula` key,
 * read from here — this file is the source of truth, the catalog a copy.
 */
import type Database from "better-sqlite3";
import { compileFormula, quoteIdent, storageType, type Dialect, type FormulaColumn, type FormulaType } from "./formula/compile";
import { FormulaError, renameColumnInFormula } from "./formula/parse";
import type { LakeColumn } from "./tables";

type DB = InstanceType<typeof Database>;

export const FORMULAS_KEY = "__formulas";
export type StoredFormula = { formula: string; type: FormulaType };
export type StoredFormulas = Record<string, StoredFormula>;

/** The formulas kept in a table's meta config; anything malformed is left out. */
export function extractFormulas(config: Record<string, unknown> | null | undefined): StoredFormulas {
  const raw = config?.[FORMULAS_KEY];
  if (!raw || typeof raw !== "object") return {};
  const out: StoredFormulas = {};
  for (const [name, v] of Object.entries(raw as Record<string, any>)) {
    if (v && typeof v.formula === "string" && ["number", "text", "date", "boolean"].includes(v.type)) out[name] = { formula: v.formula, type: v.type };
  }
  return out;
}

/** `config` with its formulas set to `formulas` (the key dropped when there are none). */
export function withFormulas(config: Record<string, unknown> | null | undefined, formulas: StoredFormulas): Record<string, unknown> {
  const { [FORMULAS_KEY]: _omit, ...rest } = config ?? {};
  return Object.keys(formulas).length ? { ...rest, [FORMULAS_KEY]: formulas } : rest;
}

/** Columns the engine computes itself — PRAGMA table_info leaves these out; table_xinfo marks them hidden 2 (virtual) or 3 (stored). */
export function generatedColumnNames(db: DB, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_xinfo(${quoteIdent(table)})`).all() as Array<{ name: string; hidden: number }>;
  return new Set(rows.filter((r) => r.hidden === 2 || r.hidden === 3).map((r) => r.name));
}

/** Every column a table has, formula columns included, in table order. */
export function allColumnNames(db: DB, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_xinfo(${quoteIdent(table)})`).all() as Array<{ name: string; hidden: number }>;
  return rows.filter((r) => r.hidden !== 1).map((r) => r.name);
}

export function readFormulas(db: DB, table: string): StoredFormulas {
  const row = db.prepare(`SELECT source_config_json FROM __lake_meta WHERE table_name = ?`).get(table) as { source_config_json: string | null } | undefined;
  let cfg: Record<string, unknown> | undefined;
  try { cfg = row?.source_config_json ? JSON.parse(row.source_config_json) : undefined; } catch { cfg = undefined; }
  return extractFormulas(cfg);
}

export function writeFormulas(db: DB, table: string, formulas: StoredFormulas): void {
  const row = db.prepare(`SELECT source_config_json FROM __lake_meta WHERE table_name = ?`).get(table) as { source_config_json: string | null } | undefined;
  let cfg: Record<string, unknown> = {};
  try { cfg = row?.source_config_json ? JSON.parse(row.source_config_json) : {}; } catch { /* start over */ }
  db.prepare(`UPDATE __lake_meta SET source_config_json = ?, updated_at = datetime('now') WHERE table_name = ?`)
    .run(JSON.stringify(withFormulas(cfg, formulas)), table);
}

/** A formula column's definition, for an ALTER TABLE ADD COLUMN or a CREATE TABLE; `sql` is compileFormula's output. */
export function generatedColumnDdl(name: string, sql: string, type: FormulaType, dialect: Dialect): string {
  return `${quoteIdent(name)} ${storageType(type, dialect)} GENERATED ALWAYS AS (${sql}) VIRTUAL`;
}

/** Add one formula column, already checked by compileFormula. */
export function addGeneratedColumn(db: DB, table: string, name: string, sql: string, type: FormulaType): void {
  db.prepare(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${generatedColumnDdl(name, sql, type, "sqlite")}`).run();
}

/** The formula columns that read `name` directly. */
export function formulaDependents(formulas: StoredFormulas, columns: FormulaColumn[], name: string): string[] {
  return Object.entries(formulas)
    .filter(([n, f]) => n !== name && usesOf(f.formula, columns, n).includes(name))
    .map(([n]) => n);
}

/** Every formula column worked out from `name`, directly or through others, in an order that can be added back (inputs first). */
export function dependentsInOrder(formulas: StoredFormulas, columns: FormulaColumn[], name: string): string[] {
  const all = new Set<string>();
  const collect = (n: string) => {
    for (const d of formulaDependents(formulas, columns, n)) if (!all.has(d)) { all.add(d); collect(d); }
  };
  collect(name);
  // Inputs first: each dependent after every other dependent it reads.
  const out: string[] = [];
  const done = new Set<string>();
  const visit = (n: string) => {
    if (done.has(n)) return;
    done.add(n);
    for (const u of usesOf(formulas[n]!.formula, columns, n)) if (all.has(u)) visit(u);
    out.push(n);
  };
  for (const n of all) visit(n);
  return out;
}

function usesOf(formula: string, columns: FormulaColumn[], self: string): string[] {
  try { return compileFormula(formula, { columns: columns.filter((c) => c.name !== self), dialect: "sqlite" }).uses; } catch { return []; }
}

/**
 * Put `formulas` back on a table that was just built from scratch — a
 * replace-import, a typed conversion, a refresh. Added in an order that lets
 * one formula read another. A formula is left off (and reported) when the
 * new data has a column of the same name, or when it no longer works against
 * the new columns — a column it read is gone, or changed type.
 */
export function reapplyFormulas(
  db: DB,
  table: string,
  formulas: StoredFormulas,
  baseColumns: FormulaColumn[],
): { kept: StoredFormulas; dropped: Array<{ name: string; reason: string }> } {
  const plan = planFormulas(formulas, baseColumns, "sqlite");
  for (const p of plan.add) addGeneratedColumn(db, table, p.name, p.sql, p.type);
  return { kept: plan.kept, dropped: plan.dropped };
}

export type PlannedFormula = { name: string; sql: string; type: FormulaType };

/**
 * Which of `formulas` still work over `baseColumns`, compiled for `dialect`,
 * in an order that lets one read another (inputs first). Pure — SQLite adds
 * the columns one by one (reapplyFormulas); DuckDB, which can only declare a
 * generated column when it creates a table, writes them into the CREATE.
 */
export function planFormulas(
  formulas: StoredFormulas,
  baseColumns: FormulaColumn[],
  dialect: Dialect,
): { add: PlannedFormula[]; kept: StoredFormulas; dropped: Array<{ name: string; reason: string }> } {
  const add: PlannedFormula[] = [];
  const kept: StoredFormulas = {};
  const dropped: Array<{ name: string; reason: string }> = [];
  const baseNames = new Set(baseColumns.map((c) => c.name.toLowerCase()));
  let pending = Object.entries(formulas).filter(([name]) => {
    if (!baseNames.has(name.toLowerCase())) return true;
    dropped.push({ name, reason: "the new data has a column with this name" });
    return false;
  });
  const lastError = new Map<string, string>();
  for (let progress = true; progress && pending.length > 0;) {
    progress = false;
    const available: FormulaColumn[] = [...baseColumns, ...Object.entries(kept).map(([n, f]) => ({ name: n, type: f.type, formula: f.formula }))];
    pending = pending.filter(([name, f]) => {
      try {
        const compiled = compileFormula(f.formula, { columns: available, dialect, self: name });
        add.push({ name, sql: compiled.sql, type: compiled.type });
        kept[name] = { formula: f.formula, type: compiled.type };
        progress = true;
        return false;
      } catch (e) {
        if (!(e instanceof FormulaError)) throw e;
        lastError.set(name, e.message);
        return true;
      }
    });
  }
  for (const [name] of pending) dropped.push({ name, reason: lastError.get(name) ?? "it no longer works" });
  return { add, kept, dropped };
}

/** A column renamed: its own formula entry moves, and every formula that reads it reads the new name. Both engines' rename. */
export function renameInFormulas(formulas: StoredFormulas, oldName: string, newName: string): StoredFormulas {
  const out: StoredFormulas = {};
  for (const [name, f] of Object.entries(formulas)) {
    out[name === oldName ? newName : name] = { ...f, formula: renameColumnInFormula(f.formula, oldName, newName) };
  }
  return out;
}

/** A column formula columns read can't go: say which, so the person can change or remove them first. Both engines' drop. */
export function assertNotReadByFormulas(formulas: StoredFormulas, columns: LakeColumn[], columnName: string): void {
  const readers = formulaDependents(formulas, columns, columnName);
  if (readers.length > 0) {
    throw new FormulaError(readers.length > 1 ? "used_by_formulas" : "used_by_formula", -1, { col: columnName, readers: readers.join(", ") });
  }
}
