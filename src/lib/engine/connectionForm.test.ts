import { describe, expect, it } from "vitest";
import {
  changeKind, defaultPort, describeTarget, emptyConnectionForm, fromConnection, summariseNames, testVerdict,
  toConnectionRequest, validateConnection, viewsUsingConnection, connectionField,
} from "./connectionForm";
import type { EngineConnection } from "./adminClient";

const filled = () => ({ ...emptyConnectionForm(), name: "Warehouse", host: "db.example.com", database: "sales", username: "reader", password: "pw" });

describe("kind defaults", () => {
  it("knows each kind's port", () => {
    expect(defaultPort("POSTGRESQL")).toBe(5432);
    expect(defaultPort("MYSQL")).toBe(3306);
    expect(defaultPort("SQLSERVER")).toBe(1433);
    expect(defaultPort("ORACLE")).toBe(1521);
    expect(defaultPort("TRINO")).toBe(8080);
  });

  it("moves the port with the kind unless the admin typed their own", () => {
    expect(changeKind(emptyConnectionForm(), "MYSQL").port).toBe("3306");
    expect(changeKind({ ...emptyConnectionForm(), port: "6543" }, "MYSQL").port).toBe("6543");
    expect(changeKind({ ...emptyConnectionForm(), port: "" }, "ORACLE").port).toBe("1521");
  });

  it("starts safe: verified TLS, no raw SQL", () => {
    const f = emptyConnectionForm();
    expect(f.tlsMode).toBe("VERIFY");
    expect(f.allowRawSql).toBe(false);
  });
});

describe("validateConnection", () => {
  it("accepts a complete form", () => expect(validateConnection(filled())).toEqual({}));

  it("requires the basics and a password on create only", () => {
    const e = validateConnection(emptyConnectionForm());
    expect(Object.keys(e).sort()).toEqual(["database", "host", "name", "password", "username"]);
    const edit = { ...filled(), id: "x", password: "" };
    expect(validateConnection(edit).password).toBeUndefined();
  });

  it("refuses a host that carries a scheme, path or credentials", () => {
    for (const host of ["jdbc:postgresql://h", "h/db", "u@h", "h?x=1", "a b", "http://h"]) {
      expect(validateConnection({ ...filled(), host }).host, host).toBeDefined();
    }
  });

  it("checks the port range and the database name", () => {
    expect(validateConnection({ ...filled(), port: "0" }).port).toBeDefined();
    expect(validateConnection({ ...filled(), port: "70000" }).port).toBeDefined();
    expect(validateConnection({ ...filled(), port: "54x" }).port).toBeDefined();
    expect(validateConnection({ ...filled(), port: "" }).port).toBeUndefined();
    expect(validateConnection({ ...filled(), database: "a;b" }).database).toBeDefined();
    expect(validateConnection({ ...filled(), database: "a/b" }).database).toBeDefined();
    expect(validateConnection({ ...filled(), database: "my_db.v2-x$" }).database).toBeUndefined();
  });
});

describe("toConnectionRequest", () => {
  it("sends the password on create, as the body", () => {
    const body = toConnectionRequest(filled());
    expect(body).toMatchObject({ name: "Warehouse", kind: "POSTGRESQL", host: "db.example.com", port: 5432, database: "sales", username: "reader", password: "pw", tlsMode: "VERIFY", allowRawSql: false });
    expect(body.version).toBeUndefined();
  });

  it("leaves a blank password out on edit so the stored one is kept, and sends the version", () => {
    const c: EngineConnection = { id: "i", name: "n", kind: "MYSQL", host: "h", port: 3306, database: "d", username: "u", tlsMode: "REQUIRE", allowRawSql: true, readOnlyVerified: true, hasPassword: true, version: 4 };
    const form = fromConnection(c);
    expect(form.password).toBe("");
    const body = toConnectionRequest(form);
    expect("password" in body).toBe(false);
    expect(body.version).toBe(4);
    expect(body.tlsMode).toBe("REQUIRE");
    expect(toConnectionRequest({ ...form, password: "new" }).password).toBe("new");
  });

  it("trims text fields", () => {
    expect(toConnectionRequest({ ...filled(), host: "  h.example  ", name: " X " })).toMatchObject({ host: "h.example", name: "X" });
  });
});

describe("the test verdict", () => {
  const base = { ok: true, latencyMs: 12, serverVersion: "16", readOnlyVerified: true, warnings: [] };
  it("tells a safe account from one that can write", () => {
    expect(testVerdict(base)).toBe("readOnly");
    expect(testVerdict({ ...base, readOnlyVerified: false })).toBe("canWrite");
    expect(testVerdict({ ...base, ok: false })).toBe("failed");
  });
});

describe("helpers", () => {
  it("describes the target", () => expect(describeTarget({ host: "h", port: 1, database: "d" })).toBe("h:1/d"));

  it("finds the views that use a connection", () => {
    const views = [{ id: "1", name: "A", connectionId: "c1" }, { id: "2", name: "B", connectionId: "c2" }, { id: "3", name: "C", connectionId: "c1" }];
    expect(viewsUsingConnection(views, "c1").map((v) => v.name)).toEqual(["A", "C"]);
  });

  it("shortens a list of names", () => {
    expect(summariseNames(["a", "b", "c"], 2)).toEqual({ shown: ["a", "b"], more: 1 });
    expect(summariseNames(["a"], 5)).toEqual({ shown: ["a"], more: 0 });
  });

  it("maps the engine's field names to the form's", () => {
    expect(connectionField("host")).toBe("host");
    expect(connectionField("password")).toBe("password");
    expect(connectionField("something")).toBeNull();
  });
});
