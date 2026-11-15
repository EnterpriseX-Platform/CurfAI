/**
 * The table and the cases the formula tests share: compile.test.ts runs them on
 * SQLite, compile.duckdb.test.ts on DuckDB (left out of the Community edition,
 * which has no DuckDB).
 */
import type { FormulaColumn } from "./compile";

// The Demo workspace's orders table, as the lake keeps it: every value text, empty cells NULL.
export const cols: FormulaColumn[] = [
  { name: "order_id", type: "text" }, { name: "order_date", type: "date" }, { name: "store", type: "text" },
  { name: "channel", type: "text" }, { name: "customer_id", type: "text" }, { name: "qty", type: "number" },
  { name: "unit_price", type: "number" }, { name: "revenue", type: "number" }, { name: "margin_pct", type: "number" },
  { name: "shipped_date", type: "date" }, { name: "is_gift", type: "boolean" }, { name: "notes", type: "unknown" },
  { name: "unit cost", type: "number" },
];
export const rows: Array<Record<string, string | null>> = [
  { order_id: "ORD-1", order_date: "2024-09-27", store: "Lakeshore", channel: "In store", customer_id: null, qty: "3", unit_price: "32", revenue: "96", margin_pct: "0.397", shipped_date: "2024-09-30", is_gift: "true", notes: "O'Brien said \"hi\"", "unit cost": "19.3" },
  { order_id: "ORD-2", order_date: "2024-12-31", store: "Old Town", channel: "Online", customer_id: "C-1209", qty: "6", unit_price: "169", revenue: "1014", margin_pct: "0.547", shipped_date: null, is_gift: "no", notes: null, "unit cost": null },
  { order_id: "ORD-3", order_date: "not a date", store: "Westway", channel: "In store", customer_id: "C-1", qty: "0", unit_price: "abc", revenue: "", margin_pct: "0.5", shipped_date: "2025-01-02", is_gift: null, notes: "", "unit cost": "5" },
];


// ---- The same formula, the same answers, on both engines --------------------

export const CASES: Array<[string, unknown[]]> = [
  ["revenue * margin_pct", [38.112, 554.658, null]],
  ["ROUND(revenue * margin_pct, 2)", [38.11, 554.66, null]],
  ["qty / 0", [null, null, null]],
  ["revenue / qty", [32, 169, null]],
  ["unit_price", [32, 169, null]],
  ['IF(qty >= 5, "bulk", "single")', ["single", "bulk", "single"]],
  ['store & " · " & channel', ["Lakeshore · In store", "Old Town · Online", "Westway · In store"]],
  ['customer_id & "!"', ["!", "C-1209!", "C-1!"]],
  ["YEAR(order_date)", [2024, 2024, null]],
  ["MONTH(order_date)", [9, 12, null]],
  ["DAYS(shipped_date, order_date)", [3, null, null]],
  ['order_date >= "2024-10-01"', [false, true, null]],
  ["LEFT(order_id, 3)", ["ORD", "ORD", "ORD"]],
  ["RIGHT(store, 4)", ["hore", "Town", "tway"]],
  ["UPPER(channel)", ["IN STORE", "ONLINE", "IN STORE"]],
  ["LEN(store)", [9, 8, 7]],
  ['CONTAINS(store, "town")', [false, true, false]],
  ["COALESCE(customer_id, \"walk-in\")", ["walk-in", "C-1209", "C-1"]],
  ["ISBLANK(customer_id)", [true, false, false]],
  ["IF(is_gift, 1, 0)", [1, 0, 0]],
  ["MIN([unit cost], qty, 10)", [3, 6, 0]],
  ["MAX([unit cost], qty)", [19.3, 6, 5]],
  ["ABS(-qty)", [3, 6, 0]],
  ["-(qty - 10) * 2", [14, 8, 20]],
  ["AND(qty > 1, NOT(ISBLANK(customer_id)))", [false, true, false]],
  ["OR(channel = \"Online\", qty = 0)", [false, true, true]],
  ["notes & \"\"", ["O'Brien said \"hi\"", "", ""]],
  [".5 * 2 + 5.", [6, 6, 6]],
];

export const norm = (v: unknown, type: string) => {
  if (v === null || v === undefined) return null;
  if (type === "boolean") return v === true || v === 1 || v === 1n;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return Math.round(v * 1e6) / 1e6;
  return v;
};
