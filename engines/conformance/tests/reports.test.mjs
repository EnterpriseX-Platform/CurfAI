import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { call, createTargetConnections, deleteConnections, idpUrl, mint, publishReport } from "../lib/client.mjs";

// Needs the same setup as policy.test.mjs: ENGINE_IDP_URL, ENGINE_TARGET_*, fixtures/agency_data.sql loaded, and the
// engine reading the agency_code claim as an attribute.
const skip = idpUrl && process.env.ENGINE_TARGET_HOST ? false : "set ENGINE_IDP_URL and ENGINE_TARGET_* to run this";

const json = { "content-type": "application/json" };
const send = (path, method, token, body) => call(path, { method, token, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });

let admin;
let target;
let view;
let report;

const person = (sub, roles, agency) => mint({ sub, roles, attrs: agency ? { agency_code: agency } : {} });
const unique = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const block = (id, queryId, extra = {}) => ({ id, type: "table", x: 0, y: 0, w: 12, h: 4, config: { queryId, ...extra } });
const definition = (name, parameters, dataSources, blocks) => ({
  version: 1, name, parameters, dataSources, pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks }],
});
const viewQuery = (id, binding) => ({ id, name: `Query ${id}`, dataSourceId: view, engine: { viewId: view, ...binding } });
const ids = (res, query) => res.json.dataset[query].map((r) => r.id).sort((a, b) => a - b);

function agencyReport(name) {
  return definition(
    name,
    [{ name: "from", label: "From", type: "date", default: "2026-01-01" }, { name: "min", label: "Min", type: "number", default: 0 }, { name: "agency", label: "Agency", type: "string" }],
    [
      viewQuery("ds_rows", {
        columns: ["id", "agency_code", "email", "amount"],
        filters: [
          { column: "created", op: "GE", value: { $param: "from" } },
          { column: "amount", op: "GE", value: { $param: "min" } },
          { column: "agency_code", op: "EQ", value: { $param: "agency" }, skipIfEmpty: true },
        ],
        orderBy: [{ column: "id" }],
      }),
      viewQuery("ds_detail", { columns: ["id"] }),
      { id: "ds_bad", name: "Bad", dataSourceId: target.reader, sql: "SELECT * FROM no_such_table_here" },
    ],
    [block("b1", "ds_rows", { drilldown: { queryId: "ds_detail" } }), block("b2", "ds_bad")],
  );
}

describe("reports in Curf's format", { skip }, () => {
  before(async () => {
    admin = await mint({ sub: "report-admin", roles: ["curf-admin"] });
    target = await createTargetConnections(admin);
    const created = await send("/views", "POST", admin, {
      name: unique("agency-view"), connectionId: target.reader, sql: "SELECT * FROM agency_data",
      allowedRoles: ["analyst"], piiRoles: ["hr"], bypassRoles: ["auditor"],
      rlsRules: [{ column: "agency_code", operator: "EQ", attribute: "agency_code" }],
    });
    assert.equal(created.status, 201, created.text);
    view = created.json.id;
    assert.equal((await send(`/views/${view}/publish`, "POST", admin)).status, 200);

    const saved = await send("/reports", "POST", admin, { definition: agencyReport(unique("agency-report")), runRoles: ["analyst", "hr"], note: "first" });
    assert.equal(saved.status, 201, saved.text);
    report = saved.json;
    await publishReport(report.id, admin);
  });

  after(async () => {
    if (report) await send(`/reports/${report.id}`, "DELETE", admin);
    if (view) await send(`/views/${view}`, "DELETE", admin);
    if (target) await deleteConnections(target, admin);
  });

  test("the definition is stored as sent, with every save versioned and restorable", async () => {
    const got = await call(`/reports/${report.id}`, { token: admin });
    assert.deepEqual(got.json.definition, report.definition);

    const edited = { ...report.definition, description: "second" };
    const v2 = await send(`/reports/${report.id}`, "PUT", admin, { definition: edited, runRoles: ["analyst", "hr"], version: 1, note: "described" });
    assert.equal(v2.status, 200, v2.text);
    assert.equal(v2.json.version, 2);
    assert.equal((await send(`/reports/${report.id}`, "PUT", admin, { definition: edited, version: 1 })).status, 409, "stale edit");

    const versions = await call(`/reports/${report.id}/versions`, { token: admin });
    assert.deepEqual(versions.json.map((v) => v.version), [2, 1]);
    const restored = await send(`/reports/${report.id}/restore/1`, "POST", admin);
    assert.equal(restored.json.version, 3, "restoring adds a version");
    assert.deepEqual(restored.json.definition, report.definition);
    report = restored.json;
  });

  test("a run has Curf's shape and each viewer gets their own rows", async () => {
    const mine = await send(`/reports/${report.id}/run`, "POST", await person("r1", ["analyst"], "A001"), { params: {} });
    assert.equal(mine.status, 200, mine.text);
    for (const field of ["dataset", "provenance", "params", "reportVersion", "asOf"]) assert.ok(field in mine.json, field);
    assert.deepEqual(ids(mine, "ds_rows"), [1, 2, 3]);
    assert.equal(mine.json.dataset.ds_rows[0].email, "***", "personal data is masked for them");

    const theirs = await send(`/reports/${report.id}/run`, "POST", await person("r2", ["analyst"], "A002"), { params: {} });
    assert.deepEqual(ids(theirs, "ds_rows"), [4, 5]);

    const p = mine.json.provenance.ds_rows;
    assert.match(p.dataHash, /^sha256:[0-9a-f]{24}$/);
    assert.match(p.queryHash, /^sha256:[0-9a-f]{24}$/);
    assert.equal(p.rowCount, 3);
    assert.equal(p.queryId, "ds_rows");
  });

  test("parameters are applied and checked", async () => {
    const me = await person("p1", ["analyst"], "A001");
    const run = (params) => send(`/reports/${report.id}/run`, "POST", me, { params });
    assert.deepEqual(ids(await run({ from: "2026-02-15" }), "ds_rows"), [3]);
    assert.deepEqual(ids(await run({ min: 100 }), "ds_rows"), [1, 2]);
    assert.deepEqual(ids(await run({ agency: "" }), "ds_rows"), [1, 2, 3], "blank means no filter");
    assert.deepEqual(ids(await run({ agency: "A002" }), "ds_rows"), [], "a filter cannot widen the row rule");
    for (const bad of [{ from: "31/01/2026" }, { min: "abc" }, { typo: "x" }]) {
      assert.equal((await run(bad)).status, 422, JSON.stringify(bad));
    }
  });

  test("queries only a drill-down uses are skipped, and one failing query does not sink the report", async () => {
    const res = await send(`/reports/${report.id}/run`, "POST", admin, { params: {} });
    assert.equal(res.status, 200, res.text);
    assert.ok(!("ds_detail" in res.json.dataset), "drill-only query must not run with the report");
    assert.deepEqual(res.json.dataset.ds_bad, []);
    assert.ok(res.json.provenance.ds_bad.executionError, "the failure is recorded");
    assert.ok(!("executionError" in res.json.provenance.ds_rows));
  });

  test("raw SQL in a report is for administrators only", async () => {
    const res = await send(`/reports/${report.id}/run`, "POST", await person("r3", ["analyst"], "A001"), { params: {} });
    assert.deepEqual(res.json.dataset.ds_bad, []);
    assert.ok(res.json.provenance.ds_bad.accessDeniedNote, "denied, not an error");
    assert.ok(!("executionError" in res.json.provenance.ds_bad));
  });

  test("who may run a report, and what a runner is shown", async () => {
    const stranger = await person("s1", ["stranger"], "A001");
    assert.equal((await send(`/reports/${report.id}/run`, "POST", stranger, { params: {} })).status, 404);

    const runner = await person("r4", ["analyst"], "A001");
    const shown = await call(`/reports/${report.id}`, { token: runner });
    assert.equal(shown.status, 200);
    const text = JSON.stringify(shown.json);
    assert.ok(text.includes("ds_rows") && text.includes("parameters"));
    assert.ok(!text.includes("dataSourceId") && !text.includes('"engine"') && !text.includes("no_such_table"), "no SQL or bindings for runners");

    assert.equal((await send("/reports", "POST", runner, { definition: agencyReport(unique("x")) })).status, 403);
    assert.equal((await call(`/reports/${report.id}/versions`, { token: runner })).status, 403);
  });

  test("definitions the engine cannot run are refused", async () => {
    const ok = agencyReport(unique("bad"));
    for (const bad of [
      { ...ok, version: 2 },
      { ...ok, pages: [] },
      { ...ok, dataSources: [{ id: "q", name: "Q", dataSourceId: target.reader, sql: "DELETE FROM agency_data" }] },
      { ...ok, dataSources: [{ id: "q", name: "Q", dataSourceId: target.reader, sql: "select 1", joins: [{ type: "left", queryId: "q", on: { left: "a", right: "b" }, alias: "x" }] }] },
    ]) {
      const res = await send("/reports", "POST", admin, { definition: bad });
      assert.equal(res.status, 422, JSON.stringify(bad).slice(0, 80));
      assert.equal(res.json.code, "CURF_INVALID_INPUT");
    }
  });
});
