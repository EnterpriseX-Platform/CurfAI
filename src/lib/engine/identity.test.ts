/**
 * Curf signs a short-lived token per query; the engine trusts it by checking it against Curf's public key.
 * These tests verify tokens the way the engine does (RS256 against the published JWK), so a signing bug
 * shows up here, not as a 401 from a running engine.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { ENGINE_TOKEN_TTL_SECONDS, engineIdentityConfigured, engineIssuer, engineJwks, engineRolesFor, mintEngineToken } from "./identity";

const pemOf = () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

const saved = { key: process.env.CURF_ENGINE_SIGNING_KEY, iss: process.env.CURF_ENGINE_ISSUER, auth: process.env.NEXTAUTH_URL };
beforeEach(() => {
  process.env.CURF_ENGINE_SIGNING_KEY = pemOf();
  process.env.CURF_ENGINE_ISSUER = "https://curf.example/";
});
afterEach(() => {
  for (const [name, value] of [["CURF_ENGINE_SIGNING_KEY", saved.key], ["CURF_ENGINE_ISSUER", saved.iss], ["NEXTAUTH_URL", saved.auth]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const viewer = { id: "user-1", isAdmin: false, roles: ["analyst"] };

describe("engine identity", () => {
  it("is off without a key, and a malformed key counts as off", () => {
    delete process.env.CURF_ENGINE_SIGNING_KEY;
    expect(engineIdentityConfigured()).toBe(false);
    expect(engineJwks()).toBeNull();
    expect(() => mintEngineToken({ viewer, tenantId: "t1" })).toThrow(/CURF_ENGINE_SIGNING_KEY/);
    process.env.CURF_ENGINE_SIGNING_KEY = "not a key";
    expect(engineIdentityConfigured()).toBe(false);
  });

  it("refuses a key that is not RSA", () => {
    process.env.CURF_ENGINE_SIGNING_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(engineIdentityConfigured()).toBe(false);
  });

  it("accepts a key written on one line with literal \\n, as env files carry it", () => {
    process.env.CURF_ENGINE_SIGNING_KEY = pemOf().trim().replace(/\n/g, "\\n");
    expect(engineIdentityConfigured()).toBe(true);
  });

  it("publishes only the public half", () => {
    const jwk = engineJwks()!.keys[0];
    expect(jwk).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    expect(jwk.kid).toEqual(expect.any(String));
    for (const secret of ["d", "p", "q", "dp", "dq", "qi"]) expect(jwk).not.toHaveProperty(secret);
  });

  it("signs a token the engine can verify against the published key", () => {
    const token = mintEngineToken({ viewer, tenantId: "t1", nowMs: 1_800_000_000_000 });
    const [header, payload, signature] = token.split(".");
    const jwk = engineJwks()!.keys[0];
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT", kid: jwk.kid });
    const ok = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(createPublicKey({ key: jwk as any, format: "jwk" }), Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });

  it("a token signed by another key does not verify", () => {
    const token = mintEngineToken({ viewer, tenantId: "t1" });
    const [header, payload, signature] = token.split(".");
    const other = createPublicKey(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey);
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(other, Buffer.from(signature, "base64url"))).toBe(false);
  });

  it("names the person, the workspace and the roles, and expires in a minute", () => {
    const now = 1_800_000_000_000;
    const claims = decode(mintEngineToken({ viewer, tenantId: "t1", nowMs: now }).split(".")[1]);
    expect(claims).toMatchObject({
      iss: "https://curf.example",
      sub: "user-1",
      preferred_username: "user-1",
      tenant: "t1",
      iat: now / 1000,
      exp: now / 1000 + ENGINE_TOKEN_TTL_SECONDS,
    });
    expect(ENGINE_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(60);
    expect(claims.realm_access.roles.sort()).toEqual(["analyst", "curf-viewer"]);
    expect(claims.jti).toEqual(expect.any(String));
    expect(claims).not.toHaveProperty("aud");
  });

  it("puts the audience in only when one is configured, and gives every token its own id", () => {
    const a = decode(mintEngineToken({ viewer, tenantId: "t1", audience: "engine-a" }).split(".")[1]);
    const b = decode(mintEngineToken({ viewer, tenantId: "t1" }).split(".")[1]);
    expect(a.aud).toBe("engine-a");
    expect(a.jti).not.toBe(b.jti);
  });

  it("maps Curf's roles: an admin is the engine's admin inside the workspace, others plain viewers, custom roles pass through", () => {
    expect(engineRolesFor({ id: "a", isAdmin: true, roles: [] })).toEqual(["curf-admin"]);
    expect(engineRolesFor({ id: "v", isAdmin: false, roles: [] })).toEqual(["curf-viewer"]);
    expect(engineRolesFor({ id: "h", isAdmin: false, roles: ["hr", "", "hr"] }).sort()).toEqual(["curf-viewer", "hr"]);
  });

  it("uses NEXTAUTH_URL as the issuer when none is set, and needs one", () => {
    delete process.env.CURF_ENGINE_ISSUER;
    process.env.NEXTAUTH_URL = "https://app.example/";
    expect(engineIssuer()).toBe("https://app.example");
    delete process.env.NEXTAUTH_URL;
    expect(() => mintEngineToken({ viewer, tenantId: "t1" })).toThrow(/issuer/);
  });
});
