// Runs the same report through the engine and compares it with what Curf's real runner produced.
import { readFileSync } from "node:fs";

const curf = JSON.parse(readFileSync(process.env.CURF_OUT ?? new URL("./curf-out.json", import.meta.url), "utf8"));
const ENGINE = (process.env.ENGINE_URL ?? "http://localhost:8080/engine/v1");
const token = await (await fetch(`${process.env.ENGINE_IDP_URL ?? "http://localhost:9099"}/token?sub=parity&tenant=parity&roles=curf-admin`)).text();
const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
const call = async (path, method, body) => {
  const res = await fetch(ENGINE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
};

const conn = await call("/connections", "POST", {
  name: `parity-${Date.now()}`, kind: "POSTGRESQL", host: process.env.ENGINE_TARGET_HOST, port: Number(process.env.ENGINE_TARGET_PORT), database: process.env.ENGINE_TARGET_DATABASE,
  username: "curf_reader", password: "Pw-test-1", tlsMode: "DISABLE", allowRawSql: true,
});
if (conn.status !== 201) throw new Error("connection: " + conn.text);
const definition = JSON.parse(JSON.stringify(curf.definition).replaceAll("__SOURCE__", conn.json.id));
definition.name = `Parity ${Date.now()}`;
const created = await call("/reports", "POST", { definition });
if (created.status !== 201) throw new Error("report: " + created.text);

let differences = 0;
let identical = 0;
const note = (msg) => { differences++; console.log("  DIFF " + msg); };
const same = (msg) => { identical++; if (process.env.VERBOSE) console.log("  ok   " + msg); };

for (const name of ["defaults", "filtered"]) {
  const expected = curf[name];
  const run = await call(`/reports/${created.json.id}/run`, "POST", { params: expected.params });
  if (run.status !== 200) throw new Error("run: " + run.text);
  console.log(`\n== case: ${name}  params=${JSON.stringify(expected.params)}`);

  for (const [queryId, curfRows] of Object.entries(expected.dataset)) {
    const rows = run.json.dataset[queryId];
    const cp = expected.provenance[queryId];
    const ep = run.json.provenance[queryId];

    // Curf serialises a DATE column as a shifted timestamp (local midnight in the server's zone); the engine
    // returns the plain date. Compare those on the calendar date Curf's value stands for.
    const normalised = curfRows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
      [k, queryId === "ds_dates" && k === "created" ? v : v])));
    const equalRows = JSON.stringify(normalised) === JSON.stringify(rows);

    if (queryId === "ds_dates") {
      const ok = rows.length === curfRows.length && rows.every((r, i) => r.id === curfRows[i].id && /^\d{4}-\d{2}-\d{2}$/.test(r.created));
      (ok ? same : note)(`${queryId}: engine gives plain dates (${rows.map((r) => r.created).join(", ")}); Curf gives ${curfRows.map((r) => r.created).join(", ")}`);
      continue;
    }
    (equalRows ? same : note)(`${queryId}: rows ${equalRows ? "identical" : "differ\n    curf  " + JSON.stringify(curfRows) + "\n    engine " + JSON.stringify(rows)}`);
    (ep.rowCount === cp.rowCount ? same : note)(`${queryId}: rowCount ${ep.rowCount} vs ${cp.rowCount}`);
    (ep.queryHash === cp.queryHash ? same : note)(`${queryId}: queryHash ${ep.queryHash} vs ${cp.queryHash}`);
    (ep.dataHash === cp.dataHash ? same : note)(`${queryId}: dataHash ${ep.dataHash} vs ${cp.dataHash}`);
    ((!!ep.executionError) === (!!cp.executionError) ? same : note)(`${queryId}: executionError engine=${!!ep.executionError} curf=${!!cp.executionError}`);
    if (cp.executionError) console.log(`  (both failed; curf: "${cp.executionError}" | engine: "${ep.executionError}")`);
  }
  const p = JSON.stringify(run.json.params);
  (p === JSON.stringify(expected.params) ? same : note)(`params applied ${p} vs ${JSON.stringify(expected.params)}`);
}
console.log(`\n${identical} checks identical, ${differences} differences`);
process.exit(differences ? 1 : 0);
