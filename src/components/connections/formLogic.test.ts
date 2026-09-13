/**
 * ConnectionForm's payload/validation logic used to live as two parallel
 * 5-way ternary chains inside the component — easy to update one and
 * forget the other when a connector kind's required fields change. These
 * tests pin the extracted behavior per kind so a future edit that breaks
 * the create/edit password-optionality rule, or drops a required field
 * from one path but not the other, fails here instead of silently.
 */
import { describe, it, expect } from "vitest";
import { buildConnectionPayload, isConnectionKindValid, type ConnectionFormFields } from "./formLogic";

function fields(overrides: Partial<ConnectionFormFields> = {}): ConnectionFormFields {
  return {
    kind: "rest",
    name: "My Connection",
    editing: false,
    connection: "",
    baseUrl: "",
    headers: {},
    visibility: { mode: "tenant" },
    readOnly: false,
    pg: { host: "", port: 5432, database: "", user: "", password: "", schema: "public", ssl: false },
    my: { host: "", port: 3306, database: "", user: "", password: "", ssl: false },
    sf: { account: "", username: "", password: "", warehouse: "", database: "", schema: "", role: "" },
    bq: { projectId: "", dataset: "", location: "", credentialsJson: "" },
    hs: { accessToken: "" },
    zd: { subdomain: "", email: "", apiToken: "" },
    sftp: { host: "", port: 22, username: "", authMethod: "password", password: "", privateKey: "", passphrase: "", remotePath: "" },
    ...overrides,
  };
}

describe("isConnectionKindValid", () => {
  it("rest requires baseUrl", () => {
    expect(isConnectionKindValid(fields({ kind: "rest", baseUrl: "" }))).toBe(false);
    expect(isConnectionKindValid(fields({ kind: "rest", baseUrl: "https://api.example.com" }))).toBe(true);
  });

  it("postgres requires host/database/user, and password only on create", () => {
    const base = fields({ kind: "postgres", pg: { host: "h", port: 5432, database: "d", user: "u", password: "", schema: "public", ssl: false } });
    expect(isConnectionKindValid({ ...base, editing: false })).toBe(false); // no password, creating
    expect(isConnectionKindValid({ ...base, editing: true })).toBe(true); // no password, editing = reuse stored
    expect(isConnectionKindValid({ ...base, editing: false, pg: { ...base.pg, password: "pw" } })).toBe(true);
  });

  it("mysql mirrors postgres's create-vs-edit password rule", () => {
    const base = fields({ kind: "mysql", my: { host: "h", port: 3306, database: "d", user: "u", password: "", ssl: false } });
    expect(isConnectionKindValid({ ...base, editing: false })).toBe(false);
    expect(isConnectionKindValid({ ...base, editing: true })).toBe(true);
  });

  it("snowflake requires account/username/warehouse/database", () => {
    const complete = fields({
      kind: "snowflake",
      editing: true,
      sf: { account: "a", username: "u", password: "", warehouse: "w", database: "d", schema: "", role: "" },
    });
    expect(isConnectionKindValid(complete)).toBe(true);
    expect(isConnectionKindValid({ ...complete, sf: { ...complete.sf, warehouse: "" } })).toBe(false);
  });

  it("bigquery requires projectId/dataset, credentialsJson only on create", () => {
    const base = fields({ kind: "bigquery", bq: { projectId: "p", dataset: "d", location: "", credentialsJson: "" } });
    expect(isConnectionKindValid({ ...base, editing: false })).toBe(false);
    expect(isConnectionKindValid({ ...base, editing: true })).toBe(true);
  });

  it("sqlite/other kinds require a connection string", () => {
    expect(isConnectionKindValid(fields({ kind: "sqlite", connection: "" }))).toBe(false);
    expect(isConnectionKindValid(fields({ kind: "sqlite", connection: "file:./dev.db" }))).toBe(true);
  });

  it("hubspot requires an access token on create, not on edit", () => {
    const base = fields({ kind: "hubspot", hs: { accessToken: "" } });
    expect(isConnectionKindValid({ ...base, editing: false })).toBe(false);
    expect(isConnectionKindValid({ ...base, editing: true })).toBe(true); // blank = keep existing
    expect(isConnectionKindValid({ ...base, editing: false, hs: { accessToken: "pat-123" } })).toBe(true);
  });

  it("zendesk requires subdomain+email+apiToken together on create, not on edit", () => {
    const base = fields({ kind: "zendesk", zd: { subdomain: "acme", email: "a@acme.test", apiToken: "" } });
    expect(isConnectionKindValid({ ...base, editing: false })).toBe(false); // partial — missing token
    expect(isConnectionKindValid({ ...base, editing: true })).toBe(true);
    expect(isConnectionKindValid({ ...base, editing: false, zd: { ...base.zd, apiToken: "tok" } })).toBe(true);
  });

  it("sftp requires host/username/remotePath + the active auth method's secret, not on edit", () => {
    const pwBase = fields({
      kind: "sftp",
      sftp: { host: "h", port: 22, username: "u", authMethod: "password", password: "", privateKey: "", passphrase: "", remotePath: "/data.csv" },
    });
    expect(isConnectionKindValid({ ...pwBase, editing: false })).toBe(false); // no password, creating
    expect(isConnectionKindValid({ ...pwBase, editing: true })).toBe(true); // blank = keep existing
    expect(isConnectionKindValid({ ...pwBase, editing: false, sftp: { ...pwBase.sftp, password: "pw" } })).toBe(true);

    const keyBase = fields({
      kind: "sftp",
      sftp: { host: "h", port: 22, username: "u", authMethod: "privateKey", password: "", privateKey: "", passphrase: "", remotePath: "/data.csv" },
    });
    expect(isConnectionKindValid({ ...keyBase, editing: false })).toBe(false); // password filled means nothing for privateKey auth
    expect(isConnectionKindValid({ ...keyBase, editing: false, sftp: { ...keyBase.sftp, privateKey: "-----BEGIN..." } })).toBe(true);
  });
});

describe("buildConnectionPayload", () => {
  it("omits password on edit when left blank (server reuses stored value)", () => {
    const payload = buildConnectionPayload(fields({
      kind: "postgres", editing: true,
      pg: { host: "h", port: 5432, database: "d", user: "u", password: "", schema: "public", ssl: false },
    })) as any;
    expect(payload.password).toBeUndefined();
    expect(payload.host).toBe("h");
  });

  it("includes password when the user typed a new one", () => {
    const payload = buildConnectionPayload(fields({
      kind: "postgres",
      pg: { host: "h", port: 5432, database: "d", user: "u", password: "new-pw", schema: "public", ssl: false },
    })) as any;
    expect(payload.password).toBe("new-pw");
  });

  it("snowflake defaults schema to PUBLIC and omits an empty role", () => {
    const payload = buildConnectionPayload(fields({
      kind: "snowflake",
      sf: { account: "a", username: "u", password: "pw", warehouse: "w", database: "d", schema: "", role: "  " },
    })) as any;
    expect(payload.schema).toBe("PUBLIC");
    expect(payload.role).toBeUndefined();
  });

  it("bigquery omits credentialsJson when blank, includes it when present", () => {
    const withoutCreds = buildConnectionPayload(fields({
      kind: "bigquery", editing: true,
      bq: { projectId: "p", dataset: "d", location: "", credentialsJson: "" },
    })) as any;
    expect(withoutCreds.credentialsJson).toBeUndefined();

    const withCreds = buildConnectionPayload(fields({
      kind: "bigquery",
      bq: { projectId: "p", dataset: "d", location: "us-central1", credentialsJson: '{"type":"service_account"}' },
    })) as any;
    expect(withCreds.credentialsJson).toBe('{"type":"service_account"}');
    expect(withCreds.location).toBe("us-central1");
  });

  it("rest carries baseUrl and headers straight through", () => {
    const payload = buildConnectionPayload(fields({
      kind: "rest", baseUrl: "https://api.example.com", headers: { Authorization: "Bearer x" },
    })) as any;
    expect(payload.baseUrl).toBe("https://api.example.com");
    expect(payload.headers).toEqual({ Authorization: "Bearer x" });
  });

  it("rest omits headers on edit when untouched (server keeps the stored, encrypted ones)", () => {
    const payload = buildConnectionPayload(fields({
      kind: "rest", editing: true, baseUrl: "https://api.example.com", headers: undefined,
    })) as any;
    expect(payload.headers).toBeUndefined();
    expect(payload.baseUrl).toBe("https://api.example.com");
  });

  it("rest includes headers (even {}) when the admin explicitly typed something", () => {
    const payload = buildConnectionPayload(fields({
      kind: "rest", editing: true, baseUrl: "https://api.example.com", headers: {},
    })) as any;
    expect(payload.headers).toEqual({});
  });

  it("hubspot always submits wire kind \"rest\" with a preset, never its own kind", () => {
    const payload = buildConnectionPayload(fields({
      kind: "hubspot", hs: { accessToken: "pat-123" },
    })) as any;
    expect(payload.kind).toBe("rest");
    expect(payload.preset).toEqual({ kind: "hubspot", accessToken: "pat-123" });
    expect(payload.baseUrl).toBeUndefined(); // server computes it from the preset
  });

  it("hubspot omits preset on edit when the token field is left blank", () => {
    const payload = buildConnectionPayload(fields({
      kind: "hubspot", editing: true, hs: { accessToken: "" },
    })) as any;
    expect(payload.kind).toBe("rest");
    expect(payload.preset).toBeUndefined();
  });

  it("zendesk always submits wire kind \"rest\" with a preset", () => {
    const payload = buildConnectionPayload(fields({
      kind: "zendesk", zd: { subdomain: "acme", email: "a@acme.test", apiToken: "tok" },
    })) as any;
    expect(payload.kind).toBe("rest");
    expect(payload.preset).toEqual({ kind: "zendesk", subdomain: "acme", email: "a@acme.test", apiToken: "tok" });
  });

  it("zendesk omits preset on edit unless all three fields are re-entered", () => {
    const payload = buildConnectionPayload(fields({
      kind: "zendesk", editing: true, zd: { subdomain: "acme", email: "", apiToken: "" },
    })) as any;
    expect(payload.preset).toBeUndefined();
  });

  it("sftp submits its own kind (a real persisted kind, unlike hubspot/zendesk)", () => {
    const payload = buildConnectionPayload(fields({
      kind: "sftp",
      sftp: { host: "h", port: 22, username: "u", authMethod: "password", password: "pw", privateKey: "", passphrase: "", remotePath: "/data.csv" },
    })) as any;
    expect(payload.kind).toBe("sftp");
    expect(payload.password).toBe("pw");
    expect(payload.privateKey).toBeUndefined();
    expect(payload.remotePath).toBe("/data.csv");
  });

  it("sftp only ever sends the secret matching the active authMethod", () => {
    const payload = buildConnectionPayload(fields({
      kind: "sftp",
      // password is filled in but authMethod is privateKey — must not leak through.
      sftp: { host: "h", port: 22, username: "u", authMethod: "privateKey", password: "pw", privateKey: "key", passphrase: "", remotePath: "/data.csv" },
    })) as any;
    expect(payload.password).toBeUndefined();
    expect(payload.privateKey).toBe("key");
  });

  it("sftp omits the secret on edit when left blank (server reuses the stored, encrypted one)", () => {
    const payload = buildConnectionPayload(fields({
      kind: "sftp", editing: true,
      sftp: { host: "h", port: 22, username: "u", authMethod: "password", password: "", privateKey: "", passphrase: "", remotePath: "/data.csv" },
    })) as any;
    expect(payload.password).toBeUndefined();
  });
});
