import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { call, createTargetConnections, deleteConnections, idpUrl, mint, publishReport } from "../lib/client.mjs";

// Needs the same setup as reports.test.mjs. Any engine must keep these promises: people who only run a report get the
// published version, the person who asked to publish cannot approve, and a public link reaches only what was built for
// the public and stops at once when revoked.
const skip = idpUrl && process.env.ENGINE_TARGET_HOST ? false : "set ENGINE_IDP_URL and ENGINE_TARGET_* to run this";

const json = { "content-type": "application/json" };
const send = (path, method, token, body) => call(path, { method, token, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
const unique = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let admin;
let approver;
let target;
let publicView;
const reports = [];

const definition = (name, view, extra = {}) => ({
  version: 1, name,
  parameters: [{ name: "agency", label: "Agency", type: "string" }],
  dataSources: [{ id: "ds", name: "Totals", dataSourceId: view, engine: {
    viewId: view, groupBy: ["agency_code"], aggregates: [{ fn: "SUM", column: "amount", as: "total" }], orderBy: [{ column: "agency_code" }],
    filters: [{ column: "agency_code", op: "EQ", value: { $param: "agency" }, skipIfEmpty: true }] } }],
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [{ id: "b1", type: "table", x: 0, y: 0, w: 12, h: 4, config: { queryId: "ds" } }] }],
  ...extra,
});

async function makeReport(name, runRoles = []) {
  const saved = await send("/reports", "POST", admin, { definition: definition(name, publicView), runRoles });
  assert.equal(saved.status, 201, saved.text);
  reports.push(saved.json.id);
  return saved.json.id;
}

describe("sharing, publishing and public links", { skip }, () => {
  before(async () => {
    admin = await mint({ sub: "sharing-admin", roles: ["curf-admin"] });
    approver = await mint({ sub: "conformance-checker", roles: ["curf-approver"] });
    target = await createTargetConnections(admin);
    const created = await send("/views", "POST", admin, {
      name: unique("public-view"), connectionId: target.reader, sql: "SELECT agency_code, amount FROM agency_data", allowedRoles: ["public", "analyst"],
    });
    assert.equal(created.status, 201, created.text);
    publicView = created.json.id;
    assert.equal((await send(`/views/${publicView}/publish`, "POST", admin)).status, 200);
  });

  after(async () => {
    for (const id of reports) await send(`/reports/${id}`, "DELETE", admin);
    if (publicView) await send(`/views/${publicView}`, "DELETE", admin);
    if (target) await deleteConnections(target, admin);
  });

  test("a runner gets only the published version, and nothing before it is published", async () => {
    const id = await makeReport(unique("published"), ["analyst"]);
    const me = await mint({ sub: unique("runner"), roles: ["analyst"] });
    assert.equal((await send(`/reports/${id}/run`, "POST", me, {})).status, 404);

    await publishReport(id, admin);
    const first = await send(`/reports/${id}/run`, "POST", me, {});
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.reportVersion, 1);

    const edited = await send(`/reports/${id}`, "PUT", admin, { definition: { ...definition(unique("renamed"), publicView) }, runRoles: ["analyst"], version: 1 });
    assert.equal(edited.status, 200, edited.text);
    assert.equal((await send(`/reports/${id}/run`, "POST", me, {})).json.reportVersion, 1);
    assert.equal((await send(`/reports/${id}/run`, "POST", admin, {})).json.reportVersion, 2);

    assert.equal((await send(`/reports/${id}/unpublish`, "POST", admin, {})).status, 422);
    assert.equal((await send(`/reports/${id}/unpublish`, "POST", admin, { reason: "wrong figures" })).status, 204);
    assert.equal((await send(`/reports/${id}/run`, "POST", me, {})).status, 404);
  });

  test("the person who asked to publish cannot approve; a changed report goes stale", async () => {
    const id = await makeReport(unique("sod"), ["analyst"]);
    const asked = await send(`/reports/${id}/publish-requests`, "POST", admin, { note: "please" });
    assert.equal(asked.status, 201, asked.text);
    const own = await send(`/publish-requests/${asked.json.id}/approve`, "POST", admin);
    assert.equal(own.status, 403);
    assert.equal(own.json.code, "CURF_SEGREGATION_OF_DUTIES");

    const edited = await send(`/reports/${id}`, "PUT", admin, { definition: definition(unique("sod-edit"), publicView), runRoles: ["analyst"], version: 1 });
    assert.equal(edited.status, 200, edited.text);
    const stale = await send(`/publish-requests/${asked.json.id}/approve`, "POST", approver);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, "CURF_STALE_VERSION");
    assert.equal((await send(`/publish-requests/${asked.json.id}/reject`, "POST", approver, {})).status, 422);
    assert.equal((await send(`/publish-requests/${asked.json.id}/reject`, "POST", approver, { note: "edited since" })).status, 200);
  });

  test("shares give access to a person, and expire", async () => {
    const id = await makeReport(unique("shared"));
    await publishReport(id, admin);
    const sub = unique("sharee");
    const me = await mint({ sub, roles: ["nobody"] });
    assert.equal((await send(`/reports/${id}/run`, "POST", me, {})).status, 404);
    const set = await send(`/reports/${id}/shares`, "PUT", admin, { shares: [{ subjectType: "USER", subjectId: sub, permission: "VIEW" }] });
    assert.equal(set.status, 200, set.text);
    assert.equal((await send(`/reports/${id}/run`, "POST", me, {})).status, 200);
    assert.equal((await send(`/reports/${id}/versions`, "GET", me)).status, 403);
    const past = await send(`/reports/${id}/shares`, "PUT", admin, { shares: [{ subjectType: "USER", subjectId: sub, permission: "VIEW", expiresAt: "2020-01-01T00:00:00Z" }] });
    assert.equal(past.status, 422);
  });

  test("a public link runs with the link's own parameters and stops the moment it is revoked", async () => {
    const id = await makeReport(unique("public"));
    assert.equal((await send(`/reports/${id}/public-links`, "POST", approver, {})).status, 404, "not published yet");
    await publishReport(id, admin);
    const created = await send(`/reports/${id}/public-links`, "POST", approver, { params: { agency: "A001" } });
    assert.equal(created.status, 201, created.text);
    const token = created.json.token;
    assert.match(token, /^cpl_/);

    const ran = await call(`/public/${token}/run`, { method: "POST", headers: json, body: JSON.stringify({ params: { agency: "A002" } }) });
    assert.equal(ran.status, 200, ran.text);
    assert.ok(ran.json.dataset.ds.length > 0);
    for (const row of ran.json.dataset.ds) assert.equal(row.agency_code, "A001");

    assert.equal((await send(`/public-links/${created.json.link.id}`, "DELETE", approver)).status, 204);
    const gone = await call(`/public/${token}/run`, { method: "POST", headers: json, body: "{}" });
    assert.equal(gone.status, 404);
  });

  test("a report with raw SQL or a non-public view can never go public", async () => {
    const raw = await send("/reports", "POST", admin, {
      definition: { version: 1, name: unique("raw"), parameters: [], dataSources: [{ id: "q", name: "Q", dataSourceId: target.reader, sql: "SELECT 1 AS one" }],
        pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [{ id: "b", type: "table", x: 0, y: 0, w: 12, h: 4, config: { queryId: "q" } }] }] },
    });
    assert.equal(raw.status, 201, raw.text);
    reports.push(raw.json.id);
    await publishReport(raw.json.id, admin);
    assert.equal((await send(`/reports/${raw.json.id}/public-links`, "POST", approver, {})).status, 422);

    const risky = await send("/views", "POST", admin, {
      name: unique("risky"), connectionId: target.reader, sql: "SELECT * FROM agency_data", allowedRoles: ["public"],
      rlsRules: [{ column: "agency_code", operator: "EQ", attribute: "agency_code" }],
    });
    assert.equal(risky.status, 201, risky.text);
    const refused = await send(`/views/${risky.json.id}/publish`, "POST", admin);
    assert.equal(refused.status, 422);
    await send(`/views/${risky.json.id}`, "DELETE", admin);
  });
});
