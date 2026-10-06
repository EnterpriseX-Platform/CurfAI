import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { call, idpUrl, mint } from "../lib/client.mjs";

// Needs: ENGINE_IDP_URL (tools/mock-idp.mjs), the engine configured to read the agency_code claim as an
// attribute, ENGINE_TARGET_* (see README) and fixtures/agency_data.sql loaded in the target database.
const skip = idpUrl && process.env.ENGINE_TARGET_HOST ? false : "set ENGINE_IDP_URL and ENGINE_TARGET_* to run this";

const json = { "content-type": "application/json" };
const post = (path, token, body) => call(path, { method: "POST", token, headers: json, body: JSON.stringify(body ?? {}) });
const put = (path, token, body) => call(path, { method: "PUT", token, headers: json, body: JSON.stringify(body) });

let admin;
let connection;
let view;

const ids = (res) => {
  const col = res.json.columns.findIndex((c) => c.name === "id");
  return res.json.rows.map((r) => r[col]).sort((a, b) => a - b);
};
const person = (sub, roles, agency) => mint({ sub, roles, attrs: agency ? { agency_code: agency } : {} });
const run = (token, extra = {}) => post("/queries/execute", token, { viewId: view, ...extra });

describe("views, row-level security and personal data", { skip }, () => {
  before(async () => {
    admin = await mint({ sub: "conformance-admin", roles: ["curf-admin"] });
    const made = await call("/connections", {
      method: "POST",
      token: admin,
      headers: json,
      body: JSON.stringify({
        name: `policy-${Date.now()}`,
        kind: process.env.ENGINE_TARGET_KIND ?? "POSTGRESQL",
        host: process.env.ENGINE_TARGET_HOST,
        port: process.env.ENGINE_TARGET_PORT ? Number(process.env.ENGINE_TARGET_PORT) : undefined,
        database: process.env.ENGINE_TARGET_DATABASE,
        username: process.env.ENGINE_TARGET_READER_USER,
        password: process.env.ENGINE_TARGET_PASSWORD,
        tlsMode: process.env.ENGINE_TARGET_TLS ?? "DISABLE",
      }),
    });
    assert.equal(made.status, 201, made.text);
    connection = made.json.id;

    const created = await post("/views", admin, {
      name: `agency-${Date.now()}`,
      connectionId: connection,
      sql: "SELECT * FROM agency_data",
      allowedRoles: ["analyst", "hr", "auditor"],
      piiRoles: ["hr"],
      bypassRoles: ["auditor"],
      rlsRules: [{ column: "agency_code", operator: "EQ", attribute: "agency_code" }],
      columns: [{ name: "national_id", pii: "HIDE" }],
    });
    assert.equal(created.status, 201, created.text);
    view = created.json.id;
    assert.equal((await post(`/views/${view}/publish`, admin)).status, 200);
  });

  after(async () => {
    if (view) await call(`/views/${view}`, { method: "DELETE", token: admin });
    if (connection) await call(`/connections/${connection}`, { method: "DELETE", token: admin });
  });

  test("each agency sees only its own rows", async () => {
    assert.deepEqual(ids(await run(await person("a1", ["analyst"], "A001"))), [1, 2, 3]);
    assert.deepEqual(ids(await run(await person("a2", ["analyst"], "A002"))), [4, 5]);
    assert.deepEqual(ids(await run(await person("b1", ["analyst"], "B001"))), [6]);
  });

  test("no attribute means no rows, not all rows", async () => {
    const res = await run(await person("nobody", ["analyst"]));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.rows, []);
  });

  test("a bypass role sees every row, including those with no agency", async () => {
    assert.deepEqual(ids(await run(await person("aud", ["auditor"]))), [1, 2, 3, 4, 5, 6, 7]);
  });

  test("the entitlement table fills in for a missing claim and the token wins when present", async () => {
    const subject = `ent-${Date.now()}`;
    const viaTable = await person(subject, ["analyst"]);
    assert.deepEqual(ids(await run(viaTable)), []);

    const set = await put("/policies/entitlements", admin, { entries: [{ subject, attribute: "agency_code", values: ["A002"] }] });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(ids(await run(viaTable)), [4, 5]);
    assert.deepEqual(ids(await run(await person(subject, ["analyst"], "A001"))), [1, 2, 3]);

    await put("/policies/entitlements", admin, { entries: [{ subject, attribute: "agency_code", values: [] }] });
    assert.deepEqual(ids(await run(viaTable)), []);
  });

  test("personal data is masked, hidden or shown by role", async () => {
    const masked = await run(await person("m1", ["analyst"], "A001"), { orderBy: [{ column: "id" }] });
    const names = masked.json.columns.map((c) => c.name);
    assert.ok(!names.includes("national_id"), "hidden column must not be offered");
    const row = Object.fromEntries(names.map((n, i) => [n, masked.json.rows[0][i]]));
    assert.equal(row.email, "***");
    assert.equal(row.salary, null);
    assert.equal(row.name, "Somchai");

    const shown = await run(await person("h1", ["hr"], "A001"), { orderBy: [{ column: "id" }] });
    const shownNames = shown.json.columns.map((c) => c.name);
    const real = Object.fromEntries(shownNames.map((n, i) => [n, shown.json.rows[0][i]]));
    assert.equal(real.email, "somchai@a001.go.th");
    assert.equal(real.national_id, "1100100000011");
  });

  test("nothing a viewer sends reaches hidden data or other agencies", async () => {
    const me = await person("x1", ["analyst"], "A001");
    for (const hostile of [
      { filters: [{ column: "national_id", op: "EQ", value: "1100100000011" }] },
      { columns: ["national_id"] },
      { orderBy: [{ column: "id; DROP TABLE agency_data" }] },
      { aggregates: [{ fn: "COUNT", as: "x; DROP TABLE agency_data" }] },
      { params: { __r0_0: "A002" } },
    ]) {
      const res = await run(me, hostile);
      assert.equal(res.status, 422, JSON.stringify(hostile));
    }
    assert.deepEqual(ids(await run(me, { filters: [{ column: "agency_code", op: "IN", values: ["A001", "A002", "B001"] }] })), [1, 2, 3]);
    assert.deepEqual(ids(await run(me, { filters: [{ column: "name", op: "EQ", value: "x' OR '1'='1" }] })), []);

    const raw = await post("/queries/execute", me, { connectionId: connection, sql: "SELECT * FROM agency_data" });
    assert.equal(raw.status, 403, "viewers have no raw SQL lane");
  });

  test("aggregates only cover the rows a viewer may see", async () => {
    const res = await run(await person("g1", ["analyst"], "A001"), {
      groupBy: ["agency_code"],
      aggregates: [{ fn: "SUM", column: "amount", as: "total" }, { fn: "COUNT" }],
    });
    assert.equal(res.json.rows.length, 1);
    assert.equal(res.json.rows[0][0], "A001");
    assert.equal(Number(res.json.rows[0][1]), 350.75);
    assert.equal(Number(res.json.rows[0][2]), 3);
  });

  test("viewers share a cached answer only when the policy outcome is identical", async () => {
    const asked = { maxAgeSeconds: 60, filters: [{ column: "id", op: "GT", value: -Math.floor(Math.random() * 1e6) - 10 }] };
    const first = await person("c1", ["analyst"], "A001");
    assert.equal((await run(first, asked)).json.cache, "miss");
    assert.equal((await run(first, asked)).json.cache, "hit");
    assert.equal((await run(await person("c2", ["analyst"], "A001"), asked)).json.cache, "hit");
    assert.equal((await run(await person("c3", ["analyst"], "A002"), asked)).json.cache, "miss");
    assert.equal((await run(await person("c4", ["hr"], "A001"), asked)).json.cache, "miss");
  });

  test("a draft or an unknown view looks the same to a viewer, and managers can see drafts", async () => {
    const draft = await post("/views", admin, {
      name: `draft-${Date.now()}`, connectionId: connection, sql: "SELECT * FROM agency_data", allowedRoles: ["analyst"],
    });
    assert.equal(draft.status, 201, draft.text);
    const me = await person("d1", ["analyst"], "A001");

    const unpublished = await post("/queries/execute", me, { viewId: draft.json.id });
    const unknown = await post("/queries/execute", me, { viewId: "00000000-0000-0000-0000-000000000000" });
    assert.equal(unpublished.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(unpublished.json.detail, unknown.json.detail);
    assert.equal((await call(`/views/${draft.json.id}`, { token: admin })).status, 200);

    await call(`/views/${draft.json.id}`, { method: "DELETE", token: admin });
  });

  test("only managers define views and only policy managers set entitlements", async () => {
    const analyst = await person("z1", ["analyst"], "A001");
    const created = await post("/views", analyst, { name: "x", connectionId: connection, sql: "SELECT 1 AS one" });
    assert.equal(created.status, 403);
    const developer = await person("z2", ["curf-developer"]);
    const set = await put("/policies/entitlements", developer, { entries: [{ subject: "s", attribute: "agency_code", values: ["A001"] }] });
    assert.equal(set.status, 403);
  });
});
