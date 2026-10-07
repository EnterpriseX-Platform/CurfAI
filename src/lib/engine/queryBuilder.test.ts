import { describe, expect, it } from "vitest";
import { EngineQuerySchema } from "@/lib/reporting/schema";
import {
  addAggregate, addFilter, addOrder, bindFilterParam, canAggregate, columnFamily, filterHasParam, formatList,
  initialQuery, mergeTableColumns, newFilter, normalizeQuery, opsForFamily, outputNames, parseList, parseLiteral,
  removeAggregate, removeFilter, removeOrder, selectedColumns, setColumns, setFilterColumn, setFilterOp,
  setFilterSkipIfEmpty, setFilterValue, setFilterValues, setLimit, setView, suggestTableColumns, toggleColumn,
  toggleGroupBy, updateAggregate, updateOrder, validateEngineQuery,
  type EngineView,
} from "./queryBuilder";

const sales: EngineView = {
  id: "sales", name: "Sales", version: 3,
  columns: [
    { name: "region", type: "varchar(50)", label: "Region", masked: false },
    { name: "revenue", type: "numeric(10,2)", label: "Revenue", masked: false },
    { name: "units", type: "integer", masked: false },
    { name: "sold_on", type: "date", masked: false },
    { name: "created_at", type: "timestamp with time zone", masked: false },
    { name: "active", type: "boolean", masked: false },
    { name: "email", type: "text", masked: true },
  ],
};
const orders: EngineView = {
  id: "orders", name: "Orders", version: 1,
  columns: [
    { name: "region", type: "text", masked: false },
    { name: "total", type: "double precision", masked: false },
    { name: "status", type: "varchar", masked: false },
  ],
};

const problems = (q: any, view: EngineView | null = sales, params: string[] = []) =>
  validateEngineQuery(q, view, params).map((p) => `${p.field}:${p.key.replace("engineQuery.problem.", "")}`);

describe("columnFamily", () => {
  it.each([
    ["integer", "number"], ["int4", "number"], ["INT", "number"], ["bigint", "number"], ["numeric(10,2)", "number"],
    ["decimal(8, 3)", "number"], ["double precision", "number"], ["float8", "number"], ["float", "number"], ["real", "number"],
    ["varchar(50)", "text"], ["character varying", "text"], ["text", "text"], ["VARCHAR", "text"], ["uuid", "text"],
    ["date", "date"], ["timestamp", "date"], ["timestamptz", "date"], ["timestamp with time zone", "date"], ["datetime2", "date"],
    ["boolean", "boolean"], ["bool", "boolean"],
    ["interval", "other"], ["jsonb", "other"], ["", "other"], [undefined, "other"], [null, "other"], ["  Integer ", "number"],
  ])("%s -> %s", (type, family) => {
    expect(columnFamily(type as any)).toBe(family);
  });
});

describe("operators per family", () => {
  it("offers range operators only where order means something", () => {
    expect(opsForFamily("number")).toContain("BETWEEN");
    expect(opsForFamily("date")).toContain("GT");
    expect(opsForFamily("text")).toContain("LIKE");
    expect(opsForFamily("text")).not.toContain("GT");
    expect(opsForFamily("boolean")).not.toContain("IN");
    expect(opsForFamily("number")).not.toContain("LIKE");
  });
});

describe("literals", () => {
  it("types a number column's text as a number when it reads as one", () => {
    expect(parseLiteral("number", " 42 ")).toBe(42);
    expect(parseLiteral("number", "1.5")).toBe(1.5);
    expect(parseLiteral("number", "")).toBe("");
    expect(parseLiteral("number", "abc")).toBe("abc");
    expect(parseLiteral("boolean", "True")).toBe(true);
    expect(parseLiteral("text", "007")).toBe("007");
  });
  it("round-trips a list", () => {
    expect(parseList("number", "1, 2,, 3 ")).toEqual([1, 2, 3]);
    expect(formatList([1, "a", { $param: "p" }])).toBe("1, a, ");
  });
});

describe("setView", () => {
  it("starts from an empty query for no view", () => {
    expect(initialQuery()).toEqual({ viewId: "" });
    expect(initialQuery(sales)).toEqual({ viewId: "sales" });
  });

  it("keeps what the new view also has and drops the rest", () => {
    let q = initialQuery(sales);
    q = setColumns(q, sales, ["region", "revenue", "units"]);
    q = addFilter(q, sales, "region");
    q = addFilter(q, sales, "units");
    q = addOrder(q, sales, "units");
    q = setLimit(q, 100);
    const next = setView(q, orders);
    expect(next.viewId).toBe("orders");
    expect(next.columns).toEqual(["region"]);
    expect(next.filters?.map((f) => f.column)).toEqual(["region"]);
    expect(next.orderBy).toBeUndefined();
    expect(next.limit).toBe(100);
  });

  it("drops a column list that shares nothing, so the new view returns all its columns", () => {
    const q = setColumns(initialQuery(sales), sales, ["units"]);
    expect(setView(q, orders).columns).toBeUndefined();
  });

  it("drops a filter whose operator the column's type does not allow in the new view", () => {
    // revenue is a number in sales (GT allowed) but status is text in orders
    let q = initialQuery(sales);
    q = addFilter(q, sales, "region");
    q = setFilterOp(q, 0, "LIKE");
    const asNumber: EngineView = { ...orders, columns: [{ name: "region", type: "integer", masked: false }] };
    expect(setView(q, asNumber).filters).toBeUndefined();
  });

  it("drops groupBy and totals the new view cannot serve, and SUM on a non-number", () => {
    let q = initialQuery(sales);
    q = toggleGroupBy(q, sales, "region");
    q = toggleGroupBy(q, sales, "units");
    q = addAggregate(q, sales, "SUM", "units");
    q = addAggregate(q, sales, "SUM", "revenue");
    q = addAggregate(q, sales, "COUNT");
    const asText: EngineView = { ...orders, columns: [{ name: "region", type: "text", masked: false }, { name: "units", type: "text", masked: false }] };
    const next = setView(q, asText);
    expect(next.groupBy).toEqual(["region", "units"]);
    expect(next.aggregates).toEqual([{ fn: "COUNT" }]);
  });

  it("clearing a view clears everything but the limit", () => {
    let q = addFilter(initialQuery(sales), sales);
    q = setLimit(q, 5);
    expect(setView(q, null)).toEqual({ viewId: "", limit: 5 });
  });

  it("choosing the same view again changes nothing", () => {
    const q = toggleColumn(initialQuery(sales), sales, "email");
    expect(setView(q, sales)).toEqual(q);
  });
});

describe("columns", () => {
  it("all columns is the same as no list", () => {
    const q = initialQuery(sales);
    expect(selectedColumns(q, sales)).toHaveLength(7);
    const less = toggleColumn(q, sales, "email");
    expect(less.columns).toHaveLength(6);
    expect(less.columns).not.toContain("email");
    expect(toggleColumn(less, sales, "email").columns).toBeUndefined();
  });

  it("keeps the view's order, whatever order they were picked in", () => {
    const q = setColumns(initialQuery(sales), sales, ["units", "region"]);
    expect(q.columns).toEqual(["region", "units"]);
  });

  it("allows an empty pick (so the editor can say pick at least one) but never saves it as 'none means all'", () => {
    let q = setColumns(initialQuery(sales), sales, []);
    expect(q.columns).toEqual([]);
    expect(problems(q)).toContain("columns:noColumns");
    q = setColumns(q, sales, sales.columns.map((c) => c.name));
    expect(q.columns).toBeUndefined();
  });

  it("ignores a column the view does not have", () => {
    const q = initialQuery(sales);
    expect(toggleColumn(q, sales, "nope")).toEqual(q);
  });

  it("ignores column toggles while the query groups", () => {
    const q = toggleGroupBy(initialQuery(sales), sales, "region");
    expect(toggleColumn(q, sales, "units")).toEqual(q);
  });
});

describe("filters", () => {
  it("starts on the first column with its first operator and an empty value", () => {
    expect(newFilter(sales)).toEqual({ column: "region", op: "EQ", value: "" });
  });

  it("shapes value and values to the operator", () => {
    let q = addFilter(initialQuery(sales), sales, "revenue");
    q = setFilterValue(q, 0, 10);
    expect(q.filters![0]).toEqual({ column: "revenue", op: "EQ", value: 10 });

    q = setFilterOp(q, 0, "BETWEEN");
    expect(q.filters![0]).toEqual({ column: "revenue", op: "BETWEEN", values: [10, ""] });
    q = setFilterValue(q, 0, 20, 1);
    expect(q.filters![0].values).toEqual([10, 20]);

    q = setFilterOp(q, 0, "IN");
    expect(q.filters![0]).toEqual({ column: "revenue", op: "IN", values: [10, 20] });

    q = setFilterOp(q, 0, "IS_NULL");
    expect(q.filters![0]).toEqual({ column: "revenue", op: "IS_NULL" });

    q = setFilterOp(q, 0, "GT");
    expect(q.filters![0]).toEqual({ column: "revenue", op: "GT", value: "" });
  });

  it("moving from a list to a single value keeps the first one", () => {
    let q = addFilter(initialQuery(sales), sales, "revenue");
    q = setFilterOp(q, 0, "IN");
    q = setFilterValues(q, 0, [3, 4]);
    q = setFilterOp(q, 0, "NE");
    expect(q.filters![0]).toEqual({ column: "revenue", op: "NE", value: 3 });
  });

  it("BETWEEN always holds exactly two", () => {
    let q = addFilter(initialQuery(sales), sales, "revenue");
    q = setFilterOp(q, 0, "IN");
    q = setFilterValues(q, 0, [1, 2, 3]);
    q = setFilterOp(q, 0, "BETWEEN");
    expect(q.filters![0].values).toEqual([1, 2]);
  });

  it("changing the column keeps a still-valid operator, resets an invalid one, and clears literals of another kind", () => {
    let q = addFilter(initialQuery(sales), sales, "region");
    q = setFilterOp(q, 0, "LIKE");
    q = setFilterValue(q, 0, "North%");
    // text -> text keeps LIKE and the value is moved over
    expect(setFilterColumn(q, sales, 0, "email").filters![0]).toEqual({ column: "email", op: "LIKE", value: "North%" });
    // text -> number: LIKE not allowed, literal cleared
    expect(setFilterColumn(q, sales, 0, "units").filters![0]).toEqual({ column: "units", op: "EQ", value: "" });
  });

  it("a parameter binding survives a column change of another kind", () => {
    let q = addFilter(initialQuery(sales), sales, "region");
    q = bindFilterParam(q, 0, "area");
    expect(setFilterColumn(q, sales, 0, "units").filters![0].value).toEqual({ $param: "area" });
  });

  it("binds a value to a parameter and back", () => {
    let q = addFilter(initialQuery(sales), sales, "region");
    q = bindFilterParam(q, 0, "area");
    expect(q.filters![0]).toEqual({ column: "region", op: "EQ", value: { $param: "area" } });
    expect(filterHasParam(q.filters![0])).toBe(true);
    q = bindFilterParam(q, 0, null);
    expect(q.filters![0].value).toBe("");
    expect(filterHasParam(q.filters![0])).toBe(false);
  });

  it("binds each BETWEEN slot and an IN list separately", () => {
    let q = addFilter(initialQuery(sales), sales, "sold_on");
    q = setFilterOp(q, 0, "BETWEEN");
    q = bindFilterParam(q, 0, "from", 0);
    q = bindFilterParam(q, 0, "to", 1);
    expect(q.filters![0].values).toEqual([{ $param: "from" }, { $param: "to" }]);

    let r = addFilter(initialQuery(sales), sales, "region");
    r = setFilterOp(r, 0, "IN");
    r = bindFilterParam(r, 0, "regions");
    expect(r.filters![0]).toEqual({ column: "region", op: "IN", values: [{ $param: "regions" }] });
  });

  it("'ignore when empty' only sticks while a parameter is bound", () => {
    let q = addFilter(initialQuery(sales), sales, "region");
    q = setFilterSkipIfEmpty(q, 0, true);
    expect(q.filters![0].skipIfEmpty).toBeUndefined(); // nothing bound yet
    q = bindFilterParam(q, 0, "area");
    q = setFilterSkipIfEmpty(q, 0, true);
    expect(q.filters![0].skipIfEmpty).toBe(true);
    q = setFilterOp(q, 0, "NE");
    expect(q.filters![0].skipIfEmpty).toBe(true);
    q = setFilterSkipIfEmpty(q, 0, false);
    expect(q.filters![0].skipIfEmpty).toBeUndefined();
    q = setFilterSkipIfEmpty(q, 0, true);
    q = bindFilterParam(q, 0, null);
    expect(q.filters![0].skipIfEmpty).toBeUndefined();
  });

  it("removes a filter and leaves no empty list behind", () => {
    let q = addFilter(initialQuery(sales), sales);
    q = removeFilter(q, 0);
    expect(q).toEqual({ viewId: "sales" });
    expect("filters" in q).toBe(false);
  });

  it("stops at the engine's filter limit", () => {
    let q = initialQuery(sales);
    for (let i = 0; i < 60; i++) q = addFilter(q, sales);
    expect(q.filters).toHaveLength(50);
  });
});

describe("group and totals", () => {
  it("grouping drops the column list; ungrouping leaves all columns", () => {
    let q = setColumns(initialQuery(sales), sales, ["region", "units"]);
    q = toggleGroupBy(q, sales, "region");
    expect(q.columns).toBeUndefined();
    expect(q.groupBy).toEqual(["region"]);
    q = toggleGroupBy(q, sales, "region");
    expect(q).toEqual({ viewId: "sales" });
  });

  it("a total alone (no groups) also takes over from the column list", () => {
    let q = setColumns(initialQuery(sales), sales, ["region"]);
    q = addAggregate(q, sales, "COUNT");
    expect(q.columns).toBeUndefined();
    expect(q.aggregates).toEqual([{ fn: "COUNT" }]);
    expect(outputNames(q, sales)).toEqual(["count_all"]);
  });

  it("SUM and AVG start on a number column and cannot be moved to a non-number", () => {
    let q = addAggregate(initialQuery(sales), sales, "SUM");
    expect(q.aggregates![0]).toEqual({ fn: "SUM", column: "revenue" });
    q = updateAggregate(q, sales, 0, { column: "region" });
    expect(q.aggregates![0].column).toBe("revenue");
    q = updateAggregate(q, sales, 0, { column: "units" });
    expect(q.aggregates![0].column).toBe("units");
  });

  it("changing COUNT(region) to AVG moves off the text column", () => {
    let q = addAggregate(initialQuery(sales), sales, "COUNT", "region");
    q = updateAggregate(q, sales, 0, { fn: "AVG" });
    expect(q.aggregates![0]).toEqual({ fn: "AVG", column: "revenue" });
  });

  it("SUM in a view with no number column has no column to take, which validation reports", () => {
    const textOnly: EngineView = { id: "t", name: "T", version: 1, columns: [{ name: "a", type: "text", masked: false }] };
    const q = addAggregate(initialQuery(textOnly), textOnly, "SUM");
    expect(q.aggregates![0]).toEqual({ fn: "SUM" });
    expect(problems(q, textOnly)).toContain("aggregates[0]:aggNeedsColumn");
  });

  it("MIN/MAX/COUNT work on any column; SUM/AVG need a number", () => {
    const region = sales.columns[0];
    const revenue = sales.columns[1];
    expect(canAggregate("MIN", region)).toBe(true);
    expect(canAggregate("COUNT", region)).toBe(true);
    expect(canAggregate("SUM", region)).toBe(false);
    expect(canAggregate("AVG", revenue)).toBe(true);
    expect(canAggregate("SUM", undefined)).toBe(false);
  });

  it("names a total the way the engine does when there is no name", () => {
    let q = toggleGroupBy(initialQuery(sales), sales, "region");
    q = addAggregate(q, sales, "SUM", "revenue");
    q = addAggregate(q, sales, "COUNT");
    expect(outputNames(q, sales)).toEqual(["region", "sum_revenue", "count_all"]);
    q = updateAggregate(q, sales, 0, { as: "total_revenue" });
    expect(outputNames(q, sales)).toEqual(["region", "total_revenue", "count_all"]);
    q = updateAggregate(q, sales, 0, { as: "  " });
    expect(q.aggregates![0].as).toBeUndefined();
  });

  it("a sort on a removed total goes with it", () => {
    let q = toggleGroupBy(initialQuery(sales), sales, "region");
    q = addAggregate(q, sales, "SUM", "revenue");
    q = addOrder(q, sales, "sum_revenue");
    expect(q.orderBy).toEqual([{ column: "sum_revenue" }]);
    q = updateAggregate(q, sales, 0, { as: "rev" });
    expect(q.orderBy).toBeUndefined();
    q = addOrder(q, sales, "rev");
    q = removeAggregate(q, sales, 0);
    expect(q.orderBy).toBeUndefined();
  });

  it("two totals can share a column", () => {
    let q = toggleGroupBy(initialQuery(sales), sales, "region");
    q = addAggregate(q, sales, "SUM", "revenue");
    q = addAggregate(q, sales, "AVG", "revenue");
    expect(outputNames(q, sales)).toEqual(["region", "sum_revenue", "avg_revenue"]);
    expect(problems(q)).toEqual([]);
  });
});

describe("sort and limit", () => {
  it("offers any view column when not grouped and only outputs when grouped", () => {
    let q = addOrder(initialQuery(sales), sales);
    expect(q.orderBy).toEqual([{ column: "region" }]);
    q = toggleGroupBy(q, sales, "units");
    // region is no longer an output
    expect(q.orderBy).toBeUndefined();
    q = addOrder(q, sales);
    expect(q.orderBy).toEqual([{ column: "units" }]);
  });

  it("toggles direction and removes", () => {
    let q = addOrder(initialQuery(sales), sales, "units");
    q = updateOrder(q, sales, 0, { descending: true });
    expect(q.orderBy).toEqual([{ column: "units", descending: true }]);
    q = updateOrder(q, sales, 0, { descending: false });
    expect(q.orderBy).toEqual([{ column: "units" }]);
    expect(removeOrder(q, sales, 0)).toEqual({ viewId: "sales" });
  });

  it("holds the limit in the engine's range", () => {
    expect(setLimit(initialQuery(sales), 50).limit).toBe(50);
    expect(setLimit(initialQuery(sales), 12.9).limit).toBe(12);
    expect(setLimit(initialQuery(sales), 10_000_000).limit).toBe(200_000);
    expect(setLimit({ viewId: "sales", limit: 5 }, null).limit).toBeUndefined();
    expect(setLimit({ viewId: "sales", limit: 5 }, 0).limit).toBeUndefined();
    expect(setLimit({ viewId: "sales", limit: 5 }, NaN).limit).toBeUndefined();
  });
});

describe("normalizeQuery", () => {
  it("fixes up a hand-edited grouped query that still lists columns", () => {
    const q = normalizeQuery({ viewId: "sales", columns: ["region", "units"], groupBy: ["region"] }, sales);
    expect(q.columns).toBeUndefined();
  });

  it("never produces something EngineQuerySchema refuses", () => {
    let q = initialQuery(sales);
    q = addFilter(q, sales, "sold_on");
    q = setFilterOp(q, 0, "BETWEEN");
    q = bindFilterParam(q, 0, "from", 0);
    q = bindFilterParam(q, 0, "to", 1);
    q = setFilterSkipIfEmpty(q, 0, true);
    q = toggleGroupBy(q, sales, "region");
    q = addAggregate(q, sales, "SUM", "revenue");
    q = addOrder(q, sales, "region");
    q = setLimit(q, 20);
    expect(EngineQuerySchema.safeParse(q).success).toBe(true);
  });
});

describe("validateEngineQuery", () => {
  it("asks for a view first", () => {
    expect(problems({ viewId: "" }, null)).toEqual(["viewId:noView"]);
  });

  it("says when the saved view is not among the ones this person may use", () => {
    expect(problems({ viewId: "gone" }, null)).toEqual(["viewId:viewMissing"]);
  });

  it("accepts a clean query", () => {
    let q = initialQuery(sales);
    q = addFilter(q, sales, "region");
    q = setFilterValue(q, 0, "North");
    expect(problems(q)).toEqual([]);
  });

  it("flags unknown columns wherever they appear", () => {
    const q = {
      viewId: "sales", columns: ["nope"], groupBy: ["nope2"], filters: [{ column: "nope3", op: "EQ", value: 1 }],
      aggregates: [{ fn: "COUNT", column: "nope4" }], orderBy: [{ column: "nope5" }],
    };
    expect(problems(q)).toEqual(expect.arrayContaining([
      "groupBy:unknownColumn", "filters[0]:unknownColumn", "aggregates[0]:unknownColumn", "orderBy[0]:orderUnknown",
    ]));
  });

  it("flags SUM/AVG on a non-number and a total without a column", () => {
    expect(problems({ viewId: "sales", aggregates: [{ fn: "SUM", column: "region" }] })).toEqual(["aggregates[0]:aggNeedsNumber"]);
    expect(problems({ viewId: "sales", aggregates: [{ fn: "AVG" }] })).toEqual(["aggregates[0]:aggNeedsColumn"]);
    expect(problems({ viewId: "sales", aggregates: [{ fn: "COUNT" }] })).toEqual([]);
  });

  it("flags a total name the engine would refuse, and a duplicate one", () => {
    expect(problems({ viewId: "sales", aggregates: [{ fn: "COUNT", as: "bad name" }] })).toEqual(["aggregates[0]:aggAliasInvalid"]);
    expect(problems({ viewId: "sales", aggregates: [{ fn: "COUNT" }, { fn: "COUNT" }] })).toEqual(["aggregates[1]:aggAliasDuplicate"]);
    expect(problems({ viewId: "sales", groupBy: ["region"], aggregates: [{ fn: "COUNT", as: "region" }] })).toEqual(["aggregates[0]:aggAliasDuplicate"]);
    expect(problems({ viewId: "sales", aggregates: [{ fn: "COUNT", as: "ยอดรวม" }] })).toEqual([]);
  });

  it("flags columns that are not group columns once the query groups", () => {
    expect(problems({ viewId: "sales", columns: ["units"], groupBy: ["region"] })).toEqual(["columns:columnsWhenGrouped"]);
    expect(problems({ viewId: "sales", columns: ["region"], groupBy: ["region"] })).toEqual([]);
  });

  it("flags a missing filter value, but not an empty parameter-bound one", () => {
    expect(problems({ viewId: "sales", filters: [{ column: "region", op: "EQ", value: "" }] })).toEqual(["filters[0]:filterValueMissing"]);
    expect(problems({ viewId: "sales", filters: [{ column: "region", op: "EQ" }] })).toEqual(["filters[0]:filterValueMissing"]);
    expect(problems({ viewId: "sales", filters: [{ column: "region", op: "IS_NULL" }] })).toEqual([]);
    expect(problems({ viewId: "sales", filters: [{ column: "active", op: "EQ", value: false }] })).toEqual([]);
    expect(problems({ viewId: "sales", filters: [{ column: "units", op: "EQ", value: 0 }] })).toEqual([]);
    expect(problems({ viewId: "sales", filters: [{ column: "region", op: "EQ", value: { $param: "a" } }] }, sales, ["a"])).toEqual([]);
  });

  it("flags a parameter that does not exist", () => {
    expect(problems({ viewId: "sales", filters: [{ column: "region", op: "EQ", value: { $param: "ghost" } }] }, sales, ["a"]))
      .toEqual(["filters[0]:filterParamUnknown"]);
    expect(problems({ viewId: "sales", filters: [{ column: "sold_on", op: "BETWEEN", values: [{ $param: "from" }, { $param: "to" }] }] }, sales, ["from"]))
      .toEqual(["filters[0]:filterParamUnknown"]);
    expect(problems({ viewId: "sales", filters: [{ column: "region", op: "IN", values: [{ $param: "x" }] }] }, sales, []))
      .toEqual(["filters[0]:filterParamUnknown"]);
  });

  it("BETWEEN needs two values", () => {
    expect(problems({ viewId: "sales", filters: [{ column: "units", op: "BETWEEN", values: [1] }] })).toEqual(["filters[0]:filterBetweenTwo"]);
    expect(problems({ viewId: "sales", filters: [{ column: "units", op: "BETWEEN", values: [1, ""] }] })).toEqual(["filters[0]:filterBetweenTwo"]);
    expect(problems({ viewId: "sales", filters: [{ column: "units", op: "BETWEEN" }] })).toEqual(["filters[0]:filterBetweenTwo"]);
    expect(problems({ viewId: "sales", filters: [{ column: "units", op: "BETWEEN", values: [1, 2] }] })).toEqual([]);
    expect(problems({ viewId: "sales", filters: [{ column: "units", op: "BETWEEN", values: [0, 9] }] })).toEqual([]);
  });

  it("IN needs at least one value", () => {
    expect(problems({ viewId: "sales", filters: [{ column: "region", op: "IN", values: [] }] })).toEqual(["filters[0]:filterListEmpty"]);
    expect(problems({ viewId: "sales", filters: [{ column: "region", op: "NOT_IN", values: ["a"] }] })).toEqual([]);
  });

  it("flags an operator the column's type does not take and text typed into a number", () => {
    expect(problems({ viewId: "sales", filters: [{ column: "region", op: "GT", value: "a" }] })).toEqual(["filters[0]:filterOpNotAllowed"]);
    expect(problems({ viewId: "sales", filters: [{ column: "units", op: "EQ", value: "abc" }] })).toEqual(["filters[0]:filterNotNumber"]);
  });

  it("flags a limit outside the range", () => {
    expect(problems({ viewId: "sales", limit: 0 })).toEqual(["limit:limitInvalid"]);
    expect(problems({ viewId: "sales", limit: 300_000 })).toEqual(["limit:limitInvalid"]);
    expect(problems({ viewId: "sales", limit: 10 })).toEqual([]);
  });

  it("fills the message values for the editor's words", () => {
    const [p] = validateEngineQuery({ viewId: "sales", columns: ["nope"] }, sales, []);
    expect(p.key).toBe("engineQuery.problem.unknownColumn");
    expect(p.values).toEqual({ column: "nope" });
  });
});

describe("suggestTableColumns", () => {
  it("lists the chosen columns with a table type each", () => {
    const q = setColumns(initialQuery(sales), sales, ["region", "revenue", "sold_on", "created_at", "active"]);
    expect(suggestTableColumns(q, sales)).toEqual([
      { key: "region", label: "Region", type: "string" },
      { key: "revenue", label: "Revenue", type: "number" },
      { key: "sold_on", label: "sold_on", type: "date" },
      { key: "created_at", label: "created_at", type: "datetime" },
      { key: "active", label: "active", type: "string" },
    ]);
  });

  it("lists every column when none are chosen", () => {
    expect(suggestTableColumns(initialQuery(sales), sales)).toHaveLength(7);
  });

  it("lists group columns then totals under the engine's names", () => {
    let q = toggleGroupBy(initialQuery(sales), sales, "region");
    q = addAggregate(q, sales, "SUM", "revenue");
    q = addAggregate(q, sales, "COUNT");
    q = addAggregate(q, sales, "MAX", "sold_on");
    q = addAggregate(q, sales, "AVG", "units");
    q = updateAggregate(q, sales, 3, { as: "avg_units_sold" });
    expect(suggestTableColumns(q, sales).map((c) => [c.key, c.type])).toEqual([
      ["region", "string"], ["sum_revenue", "number"], ["count_all", "number"], ["max_sold_on", "date"], ["avg_units_sold", "number"],
    ]);
  });

  it("words a total's heading through the caller's translation, but uses a chosen name as it is", () => {
    let q = toggleGroupBy(initialQuery(sales), sales, "region");
    q = addAggregate(q, sales, "SUM", "revenue");
    q = addAggregate(q, sales, "COUNT");
    q = updateAggregate(q, sales, 1, { as: "orders" });
    const cols = suggestTableColumns(q, sales, (fn, label) => `${fn} of ${label ?? "everything"}`);
    expect(cols.map((c) => c.label)).toEqual(["Region", "SUM of Revenue", "orders"]);
  });
});

describe("mergeTableColumns", () => {
  it("keeps what the author set on a column the table already has, adds new ones, drops the gone", () => {
    const existing: any[] = [
      { key: "units", label: "Pieces", type: "number", total: "sum", format: "0,0" },
      { key: "old", label: "Old", type: "string", total: "none" },
    ];
    const merged = mergeTableColumns(existing, [
      { key: "region", label: "Region", type: "string" },
      { key: "units", label: "units", type: "number" },
    ]);
    expect(merged).toEqual([
      { key: "region", label: "Region", type: "string", total: "none" },
      { key: "units", label: "Pieces", type: "number", total: "sum", format: "0,0" },
    ]);
  });
});
