import assert from "node:assert/strict";
import { test } from "node:test";
import { call, skipUnless, tokens } from "../lib/client.mjs";

const PROBLEM = "application/problem+json";

function assertProblem(res, status, code) {
  assert.equal(res.status, status);
  assert.ok(res.type.startsWith(PROBLEM), `expected ${PROBLEM}, got ${res.type}`);
  assert.equal(res.json.code, code);
  assert.equal(res.json.status, status);
  assert.ok(res.json.type && res.json.title, "problem needs type and title");
}

test("health is open without a token", async () => {
  const res = await call("/actuator/health");
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "UP");
});

test("everything else needs a token and fails as a problem", async () => {
  for (const path of ["/me", "/audit-events"]) {
    assertProblem(await call(path), 401, "CURF_UNAUTHENTICATED");
  }
});

test("a malformed or forged token is rejected", async () => {
  assertProblem(await call("/me", { token: "garbage" }), 401, "CURF_UNAUTHENTICATED");
  const forged = `${btoa('{"alg":"none"}')}.${btoa('{"sub":"x","iss":"https://evil.test"}')}.`;
  assertProblem(await call("/me", { token: forged }), 401, "CURF_UNAUTHENTICATED");
});

test("errors never leak internals", async () => {
  const res = await call("/does-not-exist", { token: tokens.admin ?? "garbage" });
  assert.ok([401, 404].includes(res.status));
  assert.doesNotMatch(res.text, /at com\.|at org\.|Exception|stack/i);
});

test("/me returns the viewer context", { skip: skipUnless(tokens.viewer, "viewer") }, async () => {
  const res = await call("/me", { token: tokens.viewer });
  assert.equal(res.status, 200);
  for (const key of ["tenantId", "subject", "username", "roles", "groups", "attributes", "permissions"]) {
    assert.ok(key in res.json, `missing ${key}`);
  }
});

test("audit needs the audit:read permission", { skip: skipUnless(tokens.viewer, "viewer") }, async () => {
  assertProblem(await call("/audit-events", { token: tokens.viewer }), 403, "CURF_FORBIDDEN");
});

test("audit paging is validated", { skip: skipUnless(tokens.admin, "admin") }, async () => {
  assertProblem(await call("/audit-events?size=0", { token: tokens.admin }), 422, "CURF_INVALID_INPUT");
  const ok = await call("/audit-events?size=5", { token: tokens.admin });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.json.content));
});
