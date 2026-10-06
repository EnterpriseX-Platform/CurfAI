// Shared helpers. The suite talks plain HTTP so it can run against any engine implementation.
//
//   ENGINE_URL            base URL including /engine/v1 (default http://localhost:8080/engine/v1)
//   ENGINE_TOKEN_ADMIN    bearer token for a viewer with every permission      (optional)
//   ENGINE_TOKEN_VIEWER   bearer token for a viewer with no permissions        (optional)
//
// Tests that need a token are skipped, with a reason, when it is not provided.

export const baseUrl = (process.env.ENGINE_URL ?? "http://localhost:8080/engine/v1").replace(/\/$/, "");
export const tokens = {
  admin: process.env.ENGINE_TOKEN_ADMIN,
  viewer: process.env.ENGINE_TOKEN_VIEWER,
};

export async function call(path, { token, method = "GET", headers = {}, body } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, type: res.headers.get("content-type") ?? "", json, text };
}

// A database prepared by the caller with table guard_probe(id int primary key, label varchar(50)) holding
// (1,'one'),(2,'two'),(3,'three'), and two accounts: one that can write and one that can only SELECT.
//   ENGINE_TARGET_KIND (POSTGRESQL|MYSQL|MARIADB|ORACLE|SQLSERVER), ENGINE_TARGET_HOST, ENGINE_TARGET_PORT,
//   ENGINE_TARGET_DATABASE, ENGINE_TARGET_WRITER_USER, ENGINE_TARGET_READER_USER, ENGINE_TARGET_PASSWORD
export async function createTargetConnections(token = tokens.admin) {
  const env = process.env;
  const made = { ids: [] };
  for (const [role, user] of [["writer", env.ENGINE_TARGET_WRITER_USER], ["reader", env.ENGINE_TARGET_READER_USER]]) {
    const res = await call("/connections", {
      method: "POST",
      token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `conformance-${role}-${Date.now()}`,
        kind: env.ENGINE_TARGET_KIND ?? "POSTGRESQL",
        host: env.ENGINE_TARGET_HOST,
        port: env.ENGINE_TARGET_PORT ? Number(env.ENGINE_TARGET_PORT) : undefined,
        database: env.ENGINE_TARGET_DATABASE,
        username: user,
        password: env.ENGINE_TARGET_PASSWORD,
        tlsMode: env.ENGINE_TARGET_TLS ?? "DISABLE",
        allowRawSql: true,
      }),
    });
    if (res.status !== 201) throw new Error(`could not create ${role} connection: ${res.status} ${res.text}`);
    made[role] = res.json.id;
    made.ids.push(res.json.id);
  }
  return made;
}

export async function deleteConnections(made, token = tokens.admin) {
  for (const id of made.ids) await call(`/connections/${id}`, { method: "DELETE", token });
}

// Mints tokens from tools/mock-idp.mjs (ENGINE_IDP_URL, for example http://localhost:9099) so tests can act as
// people with different roles and attributes. Not needed when the engine trusts a real identity provider and
// you pass ENGINE_TOKEN_* yourself.
export const idpUrl = process.env.ENGINE_IDP_URL;

export async function mint({ sub, roles = [], tenant = "conformance", attrs = {} }) {
  const query = new URLSearchParams({ sub, tenant, roles: roles.join(",") });
  for (const [name, value] of Object.entries(attrs)) query.set(`attr.${name}`, value);
  const res = await fetch(`${idpUrl}/token?${query}`);
  if (!res.ok) throw new Error(`identity provider said ${res.status}`);
  return res.text();
}

export function skipUnless(token, name) {
  return token ? false : `set ENGINE_TOKEN_${name.toUpperCase()} to run this`;
}

// Maker and checker: `maker` asks to publish the report's newest version, a different `checker` (role curf-approver)
// approves. People who only run a report get the published version, so a test that runs as one publishes first.
export async function publishReport(reportId, maker) {
  const json = { "content-type": "application/json" };
  const asked = await call(`/reports/${reportId}/publish-requests`, { method: "POST", token: maker, headers: json, body: JSON.stringify({ note: "conformance" }) });
  if (asked.status !== 201) throw new Error(`could not ask to publish: ${asked.status} ${asked.text}`);
  const checker = await mint({ sub: "conformance-checker", roles: ["curf-approver"] });
  const approved = await call(`/publish-requests/${asked.json.id}/approve`, { method: "POST", token: checker });
  if (approved.status !== 200) throw new Error(`could not approve: ${approved.status} ${approved.text}`);
  return checker;
}
