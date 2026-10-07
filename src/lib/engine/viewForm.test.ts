import { describe, expect, it } from "vitest";
import {
  addRole, coerceParam, detectSqlParams, emptyViewForm, filterViews, findTable, firstInvalidStep, formatCell, fromView,
  isDirty, mergeSaved, sourceKey, publicBlockers, readHandoff, resetToSuggestions, roleSuggestions, routeProblem, snapshot, sqlForTable,
  stepOfProblem, suggestViewName, syncParams, toViewRequest, validateStep, viewStatus, viewsHandoffUrl, withoutHandoff,
  type ViewForm,
} from "./viewForm";
import { parseProblem, type EngineView, type Introspection } from "./adminClient";

const engineView = (over: Partial<EngineView> = {}): EngineView => ({
  id: "v1", name: "Customers", connectionId: "c1", sql: "SELECT id, email FROM customers", version: 3, publishedVersion: 3,
  columns: [{ name: "id", type: "int4", pii: "NONE" }, { name: "email", type: "text", pii: "MASK" }],
  allowedRoles: ["curf-viewer"], piiRoles: ["curf-admin"], bypassRoles: [], rlsRules: [], refreshSeconds: 300, ...over,
});

const ready = (over: Partial<ViewForm> = {}): ViewForm => ({
  ...emptyViewForm("c1", "SELECT id, email FROM customers", "Customers"),
  id: "v1", version: 3,
  columns: [
    { name: "id", type: "int4", label: "", description: "", pii: "NONE", suggested: "NONE" },
    { name: "email", type: "text", label: "", description: "", pii: "MASK", suggested: "MASK" },
  ],
  ...over,
});

describe("public is a separate, explicit control", () => {
  it("a new view is not public", () => {
    const f = emptyViewForm();
    expect(f.isPublic).toBe(false);
    expect(toViewRequest(ready()).allowedRoles).toEqual([]);
  });

  it("adds the reserved role only when the flag is on", () => {
    expect(toViewRequest(ready({ allowedRoles: ["curf-viewer"], isPublic: true })).allowedRoles).toEqual(["curf-viewer", "public"]);
    expect(toViewRequest(ready({ allowedRoles: ["curf-viewer"], isPublic: false })).allowedRoles).toEqual(["curf-viewer"]);
  });

  it("refuses to type `public` into a role list, in any case", () => {
    expect(addRole([], "public").error).toBeDefined();
    expect(addRole(["a"], " PUBLIC ").roles).toEqual(["a"]);
    expect(addRole(["a"], "Public").error).toBeDefined();
  });

  it("splits a loaded public view into the flag and the real roles, and does not ask again", () => {
    const f = fromView(engineView({ allowedRoles: ["curf-viewer", "public"], piiRoles: ["public", "curf-admin"] }));
    expect(f.isPublic).toBe(true);
    expect(f.publicAck).toBe(true);
    expect(f.allowedRoles).toEqual(["curf-viewer"]);
    expect(f.piiRoles).toEqual(["curf-admin"]);
  });

  it("a loaded private view stays private through a round trip", () => {
    const f = fromView(engineView());
    expect(f.isPublic).toBe(false);
    expect((toViewRequest(f).allowedRoles as string[]).includes("public")).toBe(false);
  });

  it("no edit other than the flag can switch it on", () => {
    let f = fromView(engineView());
    f = { ...f, allowedRoles: addRole(f.allowedRoles, "analyst").roles, rlsRules: [{ column: "id", operator: "EQ", attribute: "a" }] };
    f = { ...f, columns: f.columns.map((c) => ({ ...c, pii: "NONE" })) };
    expect((toViewRequest(f).allowedRoles as string[])).not.toContain("public");
  });

  it("lists what blocks it: row rules, unmasked personal columns", () => {
    expect(publicBlockers(ready())).toEqual([]);
    expect(publicBlockers(ready({ rlsRules: [{ column: "id", operator: "EQ", attribute: "x" }] })).map((b) => b.code)).toEqual(["rowRules"]);
    const exposed = ready({ columns: ready().columns.map((c) => ({ ...c, pii: "NONE" })) });
    expect(publicBlockers(exposed)).toEqual([{ code: "personalColumns", columns: ["email"] }]);
  });

  it("needs the acknowledgement and no blockers to pass its step", () => {
    expect(validateStep(ready({ isPublic: true }), "public").publicAck).toBeDefined();
    expect(validateStep(ready({ isPublic: true, publicAck: true }), "public")).toEqual({});
    expect(validateStep(ready({ isPublic: true, publicAck: true, rlsRules: [{ column: "id", operator: "EQ", attribute: "x" }] }), "public").public).toBeDefined();
    expect(validateStep(ready({ isPublic: false }), "public")).toEqual({});
  });

  it("shows the engine's refusals verbatim and takes the admin to the public step", () => {
    const p = parseProblem(422, { errors: [{ field: "allowedRoles", message: "public: a view with row rules cannot be public" }, { field: "name", message: "Too long" }] });
    const routed = routeProblem(p);
    expect(routed.publicRefusals).toEqual(["a view with row rules cannot be public"]);
    expect(routed.byStep.source).toEqual(["Too long"]);
    expect(stepOfProblem(routed)).toBe("public");
  });
});

describe("the request", () => {
  it("sends overrides for every column, trimmed, and the version when editing", () => {
    const f = ready({ columns: [{ ...ready().columns[0], label: " Id ", description: " " }, ready().columns[1]], refreshSeconds: "60", description: " d " });
    const body = toViewRequest(f);
    expect(body.columns).toEqual([{ name: "id", pii: "NONE", label: "Id" }, { name: "email", pii: "MASK" }]);
    expect(body.refreshSeconds).toBe(60);
    expect(body.description).toBe("d");
    expect(body.version).toBe(3);
  });

  it("sends no columns before the engine has read them, and no version for a new view", () => {
    const body = toViewRequest(emptyViewForm("c1", "SELECT 1 AS a", "n"));
    expect("columns" in body).toBe(false);
    expect("version" in body).toBe(false);
  });

  it("sends sample parameters with sensible types", () => {
    const body = toViewRequest(ready({ sampleParams: [{ name: "year", value: "2026" }, { name: "zip", value: "01234" }, { name: "on", value: "true" }, { name: " ", value: "x" }] }));
    expect(body.sampleParams).toEqual({ year: 2026, zip: "01234", on: true });
  });
});

describe("loading and merging", () => {
  it("keeps the engine's suggestion for each column once it has been read", () => {
    const first = mergeSaved(emptyViewForm("c1", "x", "n"), engineView({ version: 1, publishedVersion: null }));
    expect(first.id).toBe("v1");
    expect(first.columns.find((c) => c.name === "email")?.suggested).toBe("MASK");
    const changed = { ...first, columns: first.columns.map((c) => (c.name === "email" ? { ...c, pii: "NONE" as const } : c)) };
    const again = mergeSaved(changed, engineView({ version: 2, publishedVersion: null, columns: [{ name: "id", type: "int4", pii: "NONE" }, { name: "email", type: "text", pii: "NONE" }, { name: "phone", type: "text", pii: "HIDE" }] }));
    expect(again.version).toBe(2);
    expect(again.columns.find((c) => c.name === "email")?.suggested).toBe("MASK");
    expect(again.columns.find((c) => c.name === "phone")?.suggested).toBe("HIDE");
  });

  it("after a new statement, keeps what was chosen for a column that is still there", () => {
    const form = ready({ columns: ready().columns.map((c) => ({ ...c, pii: "NONE" as const })) });
    const merged = mergeSaved(form, engineView({ columns: [{ name: "email", type: "text", pii: "MASK" }, { name: "phone", type: "text", pii: "HIDE" }] }), { keepChoices: true });
    expect(merged.columns.map((c) => [c.name, c.pii])).toEqual([["email", "NONE"], ["phone", "HIDE"]]);
    expect("columns" in toViewRequest(form, { omitColumns: true })).toBe(false);
  });

  it("can put columns back to the engine's suggestion", () => {
    const f = ready({ columns: ready().columns.map((c) => ({ ...c, pii: "NONE" })) });
    expect(resetToSuggestions(f).columns.map((c) => c.pii)).toEqual(["NONE", "MASK"]);
  });

  it("does not guess a suggestion for an older view", () => {
    expect(fromView(engineView()).columns.every((c) => c.suggested === null)).toBe(true);
    expect(publicBlockers({ ...fromView(engineView()), columns: fromView(engineView()).columns.map((c) => ({ ...c, pii: "NONE" as const })) })).toEqual([]);
  });
});

describe("status", () => {
  it("tells draft, published, changed and public", () => {
    expect(viewStatus({ version: 1, publishedVersion: null })).toMatchObject({ published: null, draftChanges: false });
    expect(viewStatus({ version: 3, publishedVersion: 3 })).toMatchObject({ published: 3, draftChanges: false });
    expect(viewStatus({ version: 4, publishedVersion: 3 })).toMatchObject({ published: 3, draftChanges: true });
    expect(viewStatus({ version: 3, publishedVersion: 3, allowedRoles: ["public"] })).toMatchObject({ publicLive: true, publicPending: false });
    expect(viewStatus({ version: 2, publishedVersion: null, allowedRoles: ["public"] })).toMatchObject({ publicLive: false, publicPending: true });
    expect(viewStatus({ version: 4, publishedVersion: 3, allowedRoles: ["public"] })).toMatchObject({ publicLive: false, publicPending: true });
  });

  it("filters the list by name, description and connection", () => {
    const views = [{ name: "Sales", description: "by region", connectionId: "a" }, { name: "HR", connectionId: "b" }];
    const name = (id: string) => (id === "a" ? "Warehouse" : "People DB");
    expect(filterViews(views, "", name)).toHaveLength(2);
    expect(filterViews(views, "REGION", name)).toHaveLength(1);
    expect(filterViews(views, "people", name)[0].name).toBe("HR");
    expect(filterViews(views, "zzz", name)).toHaveLength(0);
  });
});

describe("step checks", () => {
  it("source needs a name, a connection and a SELECT", () => {
    expect(Object.keys(validateStep(emptyViewForm(), "source")).sort()).toEqual(["connectionId", "name", "sql"]);
    expect(validateStep({ ...emptyViewForm("c", "DELETE FROM t", "n") }, "source").sql).toBeDefined();
    expect(validateStep({ ...emptyViewForm("c", "  with x as (select 1) select * from x", "n") }, "source")).toEqual({});
  });

  it("access checks the cache age", () => {
    expect(validateStep(ready({ refreshSeconds: "90000" }), "access").refreshSeconds).toBeDefined();
    expect(validateStep(ready({ refreshSeconds: "-1" }), "access").refreshSeconds).toBeDefined();
    expect(validateStep(ready({ refreshSeconds: "" }), "access")).toEqual({});
  });

  it("row rules need a real column, a valid attribute and no repeats", () => {
    const rule = { column: "id", operator: "EQ" as const, attribute: "agency" };
    expect(validateStep(ready({ rlsRules: [rule] }), "rows")).toEqual({});
    expect(validateStep(ready({ rlsRules: [{ ...rule, column: "nope" }] }), "rows")["rule.0.column"]).toBeDefined();
    expect(validateStep(ready({ rlsRules: [{ ...rule, attribute: "1bad" }] }), "rows")["rule.0.attribute"]).toBeDefined();
    expect(validateStep(ready({ rlsRules: [rule, rule] }), "rows")["rule.1.attribute"]).toBeDefined();
  });

  it("finds the first step with a problem", () => {
    expect(firstInvalidStep(ready())).toBeNull();
    expect(firstInvalidStep(ready({ name: "" }))?.step).toBe("source");
    expect(firstInvalidStep(ready({ refreshSeconds: "x" }))?.step).toBe("access");
  });
});

describe("roles", () => {
  it("adds, trims and de-duplicates, and refuses odd shapes", () => {
    expect(addRole([], " analyst ").roles).toEqual(["analyst"]);
    expect(addRole(["analyst"], "analyst").roles).toEqual(["analyst"]);
    expect(addRole([], "has space").error).toBeDefined();
    expect(addRole([], "a,b").error).toBeDefined();
    expect(addRole([], "").roles).toEqual([]);
    expect(addRole([], "x".repeat(65)).error).toBeDefined();
    expect(addRole([], "นักวิเคราะห์").error).toBeUndefined();
  });

  it("suggests the built-in roles, then the workspace's, never `public`", () => {
    const s = roleSuggestions([{ slug: "analyst", label: "Analyst" }, { slug: "curf-admin" }, { slug: "public" }, { slug: "ops", label: "ops" }]);
    expect(s.map((x) => x.value)).toEqual(["curf-admin", "curf-viewer", "analyst", "ops"]);
    expect(s[2].label).toBe("Analyst (analyst)");
  });
});

describe("SQL helpers", () => {
  const table = { name: "orders", type: "TABLE", columns: [{ name: "id", type: "int", nullable: false, piiSuggestion: "NONE" as const }, { name: 'we"ird', type: "text", nullable: true, piiSuggestion: "NONE" as const }] };

  it("writes a SELECT that quotes identifiers the database's way", () => {
    expect(sqlForTable("POSTGRESQL", "public", table)).toBe('SELECT "id",\n       "we""ird"\nFROM "public"."orders"');
    expect(sqlForTable("MYSQL", "shop", table)).toContain("`shop`.`orders`");
    expect(sqlForTable("SQLSERVER", "dbo", table)).toContain("[dbo].[orders]");
    expect(sqlForTable("POSTGRESQL", "", { ...table, columns: [] })).toBe('SELECT *\nFROM "orders"');
  });

  it("detects :parameters but not casts, quoted text or comments", () => {
    expect(detectSqlParams("select * from t where a = :year and b = :year and c = :Region")).toEqual(["year", "Region"]);
    expect(detectSqlParams("select a::int, 'x:y' , \"q\" from t -- :nope\n /* :no */ where z = :z")).toEqual(["z"]);
    expect(detectSqlParams("select 1")).toEqual([]);
  });

  it("keeps typed sample values when the statement changes", () => {
    const rows = syncParams("where a = :a and b = :b", [{ name: "a", value: "5" }, { name: "gone", value: "1" }]);
    expect(rows).toEqual([{ name: "a", value: "5" }, { name: "b", value: "" }]);
  });

  it("coerces plainly numeric text only", () => {
    expect(coerceParam("12")).toBe(12);
    expect(coerceParam("-1.5")).toBe(-1.5);
    expect(coerceParam("007")).toBe("007");
    expect(coerceParam("1e5")).toBe("1e5");
    expect(coerceParam("abc")).toBe("abc");
  });

  it("makes a name from a table", () => {
    expect(suggestViewName("customer_orders")).toBe("Customer orders");
    expect(suggestViewName("")).toBe("");
  });
});

describe("dirty state", () => {
  it("is clean until something changes", () => {
    const f = ready();
    const base = snapshot(f);
    expect(isDirty(f, base)).toBe(false);
    expect(isDirty({ ...f, name: "Other" }, base)).toBe(true);
    expect(isDirty({ ...f, isPublic: true }, base)).toBe(true);
    expect(isDirty({ ...f, rlsRules: [{ column: "id", operator: "IN", attribute: "x" }] }, base)).toBe(true);
  });
});

describe("the source key", () => {
  it("changes with the statement, connection or sample values, not with the name or policy", () => {
    const f = ready();
    const key = sourceKey(f);
    expect(sourceKey({ ...f, name: "Other", allowedRoles: ["x"], isPublic: true })).toBe(key);
    expect(sourceKey({ ...f, sql: "SELECT 2 AS a" })).not.toBe(key);
    expect(sourceKey({ ...f, sql: `  ${f.sql}  ` })).toBe(key);
    expect(sourceKey({ ...f, connectionId: "c2" })).not.toBe(key);
    expect(sourceKey({ ...f, sampleParams: [{ name: "a", value: "1" }] })).not.toBe(key);
    expect(sourceKey({ ...f, sampleParams: [{ name: "a", value: "" }] })).toBe(key);
  });
});

describe("hand-off from the Databases tab", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  it("builds and reads the address", () => {
    const url = viewsHandoffUrl("http://localhost/connections/engine/ds1?tab=databases", id, "public.orders");
    expect(url).toBe(`/connections/engine/ds1?tab=views&fromConnection=${id}&table=public.orders`);
    expect(readHandoff(url.split("?")[1])).toEqual({ connectionId: id, table: "public.orders" });
    expect(readHandoff(`tab=views&fromConnection=${id}`)).toEqual({ connectionId: id, table: null });
  });

  it("ignores anything that is not a connection id", () => {
    expect(readHandoff("fromConnection=../../x")).toBeNull();
    expect(readHandoff("tab=views")).toBeNull();
  });

  it("takes the hand-off out of the address once used", () => {
    expect(withoutHandoff(`http://localhost/connections/engine/ds1?tab=views&fromConnection=${id}&table=a.b`)).toBe("/connections/engine/ds1?tab=views");
  });

  it("finds a table by schema.name", () => {
    const intro: Introspection = { truncated: false, schemas: [{ name: "public", tables: [{ name: "orders", type: "TABLE", columns: [] }] }, { name: "", tables: [{ name: "solo", type: "TABLE", columns: [] }] }] };
    expect(findTable(intro, "public.orders")?.table.name).toBe("orders");
    expect(findTable(intro, "solo")?.schema).toBe("");
    expect(findTable(intro, "public.nope")).toBeNull();
  });
});

describe("engine refusals", () => {
  it("routes fields to steps", () => {
    const p = parseProblem(422, { errors: [{ field: "sql", message: "bad sql" }, { field: "rlsRules[0].column", message: "no such column" }, { field: "allowedRoles", message: "role too long" }, { field: "weird", message: "?" }] });
    const r = routeProblem(p);
    expect(r.byStep).toEqual({ source: ["bad sql"], rows: ["no such column"], access: ["role too long"] });
    expect(r.general).toEqual(["?"]);
    expect(stepOfProblem(r)).toBe("source");
  });

  it("falls back to the problem's own sentence", () => {
    expect(routeProblem(parseProblem(500, { detail: "boom" })).general).toEqual(["boom"]);
  });
});

describe("formatCell", () => {
  it("shows text, never markup handling, and cuts long values", () => {
    expect(formatCell(null)).toBe("");
    expect(formatCell("<b>x</b>")).toBe("<b>x</b>");
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
    expect(formatCell("x".repeat(500)).length).toBe(201);
  });
});
