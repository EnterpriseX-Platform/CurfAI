import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { baseUrl, call, createTargetConnections, deleteConnections, idpUrl, mint, publishReport } from "../lib/client.mjs";

// Needs the same setup as reports.test.mjs. PDF is checked too when ENGINE_PDF=1 (the engine has a Chromium sidecar).
const skip = idpUrl && process.env.ENGINE_TARGET_HOST ? false : "set ENGINE_IDP_URL and ENGINE_TARGET_* to run this";
const withPdf = process.env.ENGINE_PDF === "1";

const json = { "content-type": "application/json" };
const send = (path, method, token, body) => call(path, { method, token, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
const person = (sub, roles, agency) => mint({ sub, roles, attrs: agency ? { agency_code: agency } : {} });
const unique = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let admin;
let target;
let view;
let report;

async function bytesOf(url, token) {
  const res = await fetch(baseUrl + url.replace("/engine/v1", ""), { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

describe("exporting a report", { skip }, () => {
  before(async () => {
    admin = await mint({ sub: "export-admin", roles: ["curf-admin"] });
    target = await createTargetConnections(admin);
    const created = await send("/views", "POST", admin, {
      name: unique("export-view"), connectionId: target.reader, sql: "SELECT * FROM agency_data",
      allowedRoles: ["analyst", "hr"], piiRoles: ["hr"],
      rlsRules: [{ column: "agency_code", operator: "EQ", attribute: "agency_code" }],
    });
    assert.equal(created.status, 201, created.text);
    view = created.json.id;
    await send(`/views/${view}/publish`, "POST", admin);

    const columns = [
      { key: "id", label: "รหัส", type: "number" }, { key: "agency_code", label: "หน่วยงาน", type: "string" },
      { key: "email", label: "อีเมล", type: "string" }, { key: "amount", label: "จำนวนเงิน", type: "currency", total: "sum" },
      { key: "created", label: "วันที่", type: "date" },
    ];
    const saved = await send("/reports", "POST", admin, {
      runRoles: ["analyst", "hr"],
      definition: {
        version: 1, name: `รายงานส่งออก ${unique("x")}`, parameters: [], pages: [{ id: "p1", blocks: [
          { id: "b1", type: "table", x: 0, y: 0, w: 12, h: 4, config: { queryId: "ds", title: "รายชื่อ", columns } }] }],
        dataSources: [{ id: "ds", name: "Rows", dataSourceId: view, engine: { viewId: view,
          columns: ["id", "agency_code", "email", "amount", "created"], orderBy: [{ column: "id" }] } }],
      },
    });
    assert.equal(saved.status, 201, saved.text);
    report = saved.json.id;
    await publishReport(report, admin);
  });

  after(async () => {
    if (report) await send(`/reports/${report}`, "DELETE", admin);
    if (view) await send(`/views/${view}`, "DELETE", admin);
    if (target) await deleteConnections(target, admin);
  });

  const make = (token, format, extra = {}) => send(`/reports/${report}/exports`, "POST", token, { format, ...extra });

  test("a CSV holds the person's own rows and masks, with a matching hash", async () => {
    const me = await person("csv-1", ["analyst"], "A001");
    const created = await make(me, "CSV");
    assert.equal(created.status, 201, created.text);
    const info = created.json;
    assert.match(info.sha256, /^[0-9a-f]{64}$/);

    const file = await bytesOf(info.downloadUrl, me);
    assert.equal(file.status, 200);
    assert.equal(createHash("sha256").update(file.bytes).digest("hex"), info.sha256);
    assert.equal(file.headers.get("x-content-sha256"), info.sha256);
    assert.equal(file.headers.get("x-curf-as-of"), info.asOf);
    assert.match(file.headers.get("content-disposition"), /filename\*=UTF-8''/);
    assert.deepEqual([...file.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "byte-order mark");

    const lines = file.bytes.subarray(3).toString("utf8").split("\r\n");
    assert.equal(lines[0], "รหัส,หน่วยงาน,อีเมล,จำนวนเงิน,วันที่");
    assert.equal(lines[1], "1,A001,***,100.50,2026-01-10");
    assert.equal(lines.filter(Boolean).length, 4, "header and the three A001 rows");
  });

  test("XLSX and DOCX are real Office files", async () => {
    const me = await person("office-1", ["analyst"], "A001");
    for (const [format, type] of [["XLSX", "spreadsheetml"], ["DOCX", "wordprocessingml"]]) {
      const created = await make(me, format);
      assert.equal(created.status, 201, created.text);
      const file = await bytesOf(created.json.downloadUrl, me);
      assert.equal(file.bytes.subarray(0, 2).toString(), "PK", `${format} is a zip`);
      assert.ok(file.headers.get("content-type").includes(type));
      assert.equal(createHash("sha256").update(file.bytes).digest("hex"), created.json.sha256);
    }
  });

  test("only the creator can fetch a file", async () => {
    const me = await person("owner-1", ["analyst"], "A001");
    const info = (await make(me, "CSV")).json;
    for (const other of [await person("owner-2", ["analyst"], "A001"), admin]) {
      assert.equal((await bytesOf(info.downloadUrl, other)).status, 404);
      assert.equal((await call(`/exports/${info.id}`, { token: other })).status, 404);
    }
    assert.equal((await send(`/exports/${info.id}`, "DELETE", me)).status, 204);
    assert.equal((await bytesOf(info.downloadUrl, me)).status, 404);
  });

  test("bad requests are refused", async () => {
    const me = await person("bad-1", ["analyst"], "A001");
    for (const bad of [{}, { format: "ODT" }, { format: "CSV", locale: "fr" }, { format: "CSV", blockId: "nope" }, { format: "CSV", params: { typo: 1 } }]) {
      assert.equal((await send(`/reports/${report}/exports`, "POST", me, bad)).status, 422, JSON.stringify(bad));
    }
    assert.equal((await make(await person("bad-2", ["stranger"], "A001"), "CSV")).status, 404, "not allowed to run it");
  });

  test("PDF is a real PDF with a matching hash, or says it is unavailable", async () => {
    const me = await person("pdf-1", ["hr"], "A001");
    const created = await make(me, "PDF");
    if (!withPdf) {
      assert.ok([201, 503].includes(created.status), created.text);
      if (created.status === 503) assert.equal(created.json.code, "CURF_EXPORT_UNAVAILABLE");
      return;
    }
    assert.equal(created.status, 201, created.text);
    const file = await bytesOf(created.json.downloadUrl, me);
    assert.equal(file.bytes.subarray(0, 5).toString(), "%PDF-");
    assert.equal(createHash("sha256").update(file.bytes).digest("hex"), created.json.sha256);
  });
});
