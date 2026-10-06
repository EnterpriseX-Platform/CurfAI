import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { call, createTargetConnections, deleteConnections, idpUrl, mint, publishReport } from "../lib/client.mjs";

// Needs the same setup as reports.test.mjs, and an engine that allows the recipient domain example.test
// (curf.engine.schedules.allowed-recipient-domains). Delivery itself needs a mail server and is not checked here; this
// checks what any engine must promise about managing schedules.
const skip = idpUrl && process.env.ENGINE_TARGET_HOST ? false : "set ENGINE_IDP_URL and ENGINE_TARGET_* to run this";

const json = { "content-type": "application/json" };
const send = (path, method, token, body) => call(path, { method, token, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
const unique = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let admin;
let maker;
let target;
let view;
let report;
const schedules = [];

const body = (extra = {}) => ({
  reportId: report, name: unique("daily"), cron: "30 6 * * *", timezone: "Asia/Bangkok", format: "CSV", locale: "th",
  recipients: ["reports@example.test"], ...extra,
});

describe("scheduled delivery", { skip }, () => {
  before(async () => {
    admin = await mint({ sub: "schedule-admin", roles: ["curf-admin"] });
    maker = await mint({ sub: unique("maker"), roles: ["curf-developer", "analyst"], attrs: { agency_code: "A001" } });
    target = await createTargetConnections(admin);
    const created = await send("/views", "POST", admin, {
      name: unique("sched-view"), connectionId: target.reader, sql: "SELECT * FROM agency_data", allowedRoles: ["analyst"],
      rlsRules: [{ column: "agency_code", operator: "EQ", attribute: "agency_code" }],
    });
    assert.equal(created.status, 201, created.text);
    view = created.json.id;
    assert.equal((await send(`/views/${view}/publish`, "POST", admin)).status, 200);
    const saved = await send("/reports", "POST", admin, {
      runRoles: ["analyst"],
      definition: { version: 1, name: unique("scheduled-report"), parameters: [], pages: [{ id: "p1", blocks: [{ id: "b1", type: "table", x: 0, y: 0, w: 12, h: 4, config: { queryId: "ds" } }] }],
        dataSources: [{ id: "ds", name: "Rows", dataSourceId: view, engine: { viewId: view, columns: ["id", "agency_code", "name"], orderBy: [{ column: "id" }] } }] },
    });
    assert.equal(saved.status, 201, saved.text);
    report = saved.json.id;
    await publishReport(report, admin);
  });

  after(async () => {
    for (const id of schedules) await send(`/schedules/${id}`, "DELETE", maker);
    if (report) await send(`/reports/${report}`, "DELETE", admin);
    if (view) await send(`/views/${view}`, "DELETE", admin);
    if (target) await deleteConnections(target, admin);
  });

  test("a schedule runs as the person who saved it, shows its next fire, and can be changed and deleted", async () => {
    const created = await send("/schedules", "POST", maker, body());
    assert.equal(created.status, 201, created.text);
    schedules.push(created.json.id);
    assert.ok(new Date(created.json.nextRunAt) > new Date());
    assert.equal(created.json.enabled, true);
    assert.equal(created.json.createdBy, created.json.runAs);

    const other = await mint({ sub: unique("other"), roles: ["curf-developer", "analyst"], attrs: { agency_code: "A002" } });
    const changed = await send(`/schedules/${created.json.id}`, "PUT", other, body({ name: created.json.name }));
    assert.equal(changed.status, 200, changed.text);
    assert.notEqual(changed.json.runAs, created.json.runAs, "saving again runs it as the new person");
    assert.equal(changed.json.createdBy, created.json.createdBy);

    const off = await send(`/schedules/${created.json.id}`, "PUT", maker, body({ name: created.json.name, enabled: false }));
    assert.equal(off.json.nextRunAt, null);

    assert.equal((await call(`/schedules/${created.json.id}/runs`, { token: maker })).json.length, 0);
    assert.equal((await send(`/schedules/${created.json.id}`, "DELETE", maker)).status, 204);
    assert.equal((await call(`/schedules/${created.json.id}`, { token: maker })).status, 404);
  });

  test("bad timetables, recipients and parameters are refused", async () => {
    for (const bad of [
      { cron: "0 0 6 * * *" }, { cron: "@daily" }, { cron: "*/1 * * * *" }, { cron: "0 25 * * *" }, { timezone: "Mars/Olympus" },
      { locale: "fr" }, { format: undefined }, { params: { nope: "x" } }, { recipients: [] },
      { recipients: ["someone@elsewhere.example"] }, { recipients: ["a@example.test\r\nBcc: x@evil.test"] },
    ]) {
      const res = await send("/schedules", "POST", maker, body(bad));
      assert.equal(res.status, 422, `${JSON.stringify(bad)} -> ${res.status}`);
    }
  });

  test("only people who manage schedules, in the same workspace, can see or change them", async () => {
    const viewer = await mint({ sub: unique("viewer"), roles: ["curf-viewer"] });
    assert.equal((await send("/schedules", "POST", viewer, body())).status, 403);
    assert.equal((await call("/schedules", { token: viewer })).status, 403);

    const created = await send("/schedules", "POST", maker, body());
    assert.equal(created.status, 201, created.text);
    schedules.push(created.json.id);
    const stranger = await mint({ sub: unique("stranger"), roles: ["curf-developer"], tenant: "another-workspace" });
    assert.equal((await call(`/schedules/${created.json.id}`, { token: stranger })).status, 404);
    assert.equal((await send(`/schedules/${created.json.id}`, "DELETE", stranger)).status, 404);
    assert.equal((await send("/schedules", "POST", stranger, body())).status, 404, "no such report in their workspace");
  });
});
