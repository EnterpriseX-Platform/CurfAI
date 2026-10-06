import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { call, createTargetConnections, deleteConnections, skipUnless, tokens } from "../lib/client.mjs";

const corpus = JSON.parse(readFileSync(new URL("../corpus/guard.json", import.meta.url), "utf8"));
const skip = skipUnless(tokens.admin, "admin") || (process.env.ENGINE_TARGET_HOST ? false : "set ENGINE_TARGET_* to run this");

let connections;

async function run(connectionId, sql, params) {
  return call("/queries/execute", {
    method: "POST",
    token: tokens.admin,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectionId, sql, params }),
  });
}

describe("SQL guard corpus", { skip }, () => {
  before(async () => {
    connections = await createTargetConnections();
  });
  after(async () => {
    if (connections) await deleteConnections(connections);
  });

  for (const account of ["writer", "reader"]) {
    for (const attack of corpus.rejected) {
      test(`${account}: rejects ${attack.id}`, async () => {
        const res = await run(connections[account], attack.sql);
        assert.equal(res.status, 422, res.text);
        assert.equal(res.json.code, "CURF_SQL_REJECTED");
      });
    }
  }

  test("a writable account's data is untouched after the whole corpus", async () => {
    const res = await run(connections.reader, "SELECT id, label FROM guard_probe ORDER BY id");
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.rows, [[1, "one"], [2, "two"], [3, "three"]]);
  });

  for (const ok of corpus.accepted) {
    test(`runs ${ok.id}`, async () => {
      // An entry's variants hold the text for a database whose syntax differs (ENGINE_TARGET_KIND names it).
      const sql = ok.variants?.[process.env.ENGINE_TARGET_KIND ?? "POSTGRESQL"] ?? ok.sql;
      const res = await run(connections.reader, sql, ok.params);
      assert.equal(res.status, 200, res.text);
      assert.ok(Array.isArray(res.json.rows));
      assert.match(res.json.provenance.sha256, /^[0-9a-f]{64}$/);
    });
  }

  test("results carry provenance and honour the row cap", async () => {
    const res = await call("/queries/execute", {
      method: "POST",
      token: tokens.admin,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: connections.reader, sql: "SELECT id FROM guard_probe ORDER BY id", limit: 2 }),
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.rowCount, 2);
    assert.equal(res.json.truncated, true);
    assert.equal(res.json.cache, "miss");
    assert.ok(res.json.asOf);
  });

  test("the password never appears in any response", async () => {
    const password = process.env.ENGINE_TARGET_PASSWORD;
    for (const path of ["/connections", `/connections/${connections.reader}`, "/audit-events?size=200"]) {
      const res = await call(path, { token: tokens.admin });
      assert.ok(!res.text.includes(password), `${path} leaked the password`);
    }
  });
});
