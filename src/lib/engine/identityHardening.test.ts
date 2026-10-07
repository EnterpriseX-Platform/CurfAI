/**
 * Two protections around the engine token: a Curf custom role may not borrow the engine's own role names, and
 * the signing key can be rotated without downtime (the old key's public half stays published while tokens
 * signed by it are still valid).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { engineIdentityConfigured, engineJwks, engineRolesFor, isReservedEngineRole, mintEngineToken } from "./identity";

const keyPair = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = (k: ReturnType<typeof keyPair>) => k.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = (k: ReturnType<typeof keyPair>) => k.publicKey.export({ type: "spki", format: "pem" }).toString();
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const verifies = (token: string, jwk: any) => {
  const [h, p, s] = token.split(".");
  return createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
};

const saved = { key: process.env.CURF_ENGINE_SIGNING_KEY, prev: process.env.CURF_ENGINE_SIGNING_KEY_PREVIOUS, iss: process.env.CURF_ENGINE_ISSUER };
beforeEach(() => {
  process.env.CURF_ENGINE_SIGNING_KEY = privatePem(keyPair());
  delete process.env.CURF_ENGINE_SIGNING_KEY_PREVIOUS;
  process.env.CURF_ENGINE_ISSUER = "https://curf.example";
});
afterEach(() => {
  for (const [name, value] of [["CURF_ENGINE_SIGNING_KEY", saved.key], ["CURF_ENGINE_SIGNING_KEY_PREVIOUS", saved.prev], ["CURF_ENGINE_ISSUER", saved.iss]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const viewer = { id: "user-1", isAdmin: false, roles: ["analyst"] };

describe("reserved engine roles", () => {
  it("drops a custom role that carries engine permissions, whatever its case or spacing", () => {
    const roles = engineRolesFor({ id: "v", isAdmin: false, roles: ["analyst", "curf-admin", "CURF-Approver", " curf-viewer ", "public", "Public", "curfx"] });
    expect(roles.sort()).toEqual(["analyst", "curf-viewer", "curfx"]);
  });

  it("a person given a custom role named like an engine role gains nothing from it", () => {
    expect(engineRolesFor({ id: "v", isAdmin: false, roles: ["curf-admin"] })).toEqual(["curf-viewer"]);
    expect(isReservedEngineRole("curf-developer")).toBe(true);
    expect(isReservedEngineRole("analyst")).toBe(false);
  });

  it("the minted token never carries them", () => {
    const claims = decode(mintEngineToken({ viewer: { id: "v", isAdmin: false, roles: ["curf-approver", "hr"] }, tenantId: "t1" }).split(".")[1]);
    expect(claims.realm_access.roles.sort()).toEqual(["curf-viewer", "hr"]);
  });
});

describe("an anonymous visitor", () => {
  const claimsOf = (token: string) => decode(token.split(".")[1]);

  it("is the engine's public role and nothing else, whatever the viewer says about itself", () => {
    const claims = claimsOf(mintEngineToken({ viewer: { id: "anonymous", isAdmin: true, roles: ["curf-admin", "hr"], anonymous: true }, tenantId: "t1" }));
    expect(claims.realm_access.roles).toEqual(["public"]);
    expect(claims.sub).toBe("public:anonymous");
    expect(claims.preferred_username).toBe("public:anonymous");
    expect(claims.tenant).toBe("t1");
  });

  it("is never a viewer, an admin, or holder of a custom role", () => {
    expect(engineRolesFor({ id: "x", isAdmin: false, roles: ["analyst"], anonymous: true })).toEqual(["public"]);
    expect(engineRolesFor({ id: "x", isAdmin: true, roles: [], anonymous: true })).toEqual(["public"]);
  });

  it("only an anonymous viewer is public: a person with a custom role named public still is not", () => {
    expect(engineRolesFor({ id: "u", isAdmin: false, roles: ["public"] })).toEqual(["curf-viewer"]);
  });
});

describe("key rotation", () => {
  it("publishes the current key first, then the ones being retired, public halves only", () => {
    process.env.CURF_ENGINE_SIGNING_KEY_PREVIOUS = privatePem(keyPair()); // an operator may keep the old private key file around
    const keys = engineJwks()!.keys;
    expect(keys).toHaveLength(2);
    expect(keys[0].kid).not.toBe(keys[1].kid);
    for (const k of keys) for (const secret of ["d", "p", "q", "dp", "dq", "qi"]) expect(k).not.toHaveProperty(secret);
  });

  it("signs with the new key only, and a token the old key signed still verifies against the published set", () => {
    const old = keyPair();
    process.env.CURF_ENGINE_SIGNING_KEY = privatePem(old);
    const inFlight = mintEngineToken({ viewer, tenantId: "t1" }); // minted just before the rotation

    process.env.CURF_ENGINE_SIGNING_KEY = privatePem(keyPair()); // rotate
    process.env.CURF_ENGINE_SIGNING_KEY_PREVIOUS = publicPem(old);
    const [current, previous] = engineJwks()!.keys;
    const fresh = mintEngineToken({ viewer, tenantId: "t1" });

    expect(decode(fresh.split(".")[0]).kid).toBe(current.kid);
    expect(verifies(fresh, current)).toBe(true);
    expect(verifies(fresh, previous)).toBe(false);
    expect(decode(inFlight.split(".")[0]).kid).toBe(previous.kid);
    expect(verifies(inFlight, previous)).toBe(true);
  });

  it("accepts several previous keys, and does not list the current key twice", () => {
    process.env.CURF_ENGINE_SIGNING_KEY_PREVIOUS = [publicPem(keyPair()), publicPem(keyPair()), process.env.CURF_ENGINE_SIGNING_KEY!].join("\n");
    expect(engineJwks()!.keys).toHaveLength(3);
  });

  it("a malformed or non-RSA previous key makes the identity unusable instead of publishing something wrong", () => {
    process.env.CURF_ENGINE_SIGNING_KEY_PREVIOUS = "not a pem";
    expect(engineIdentityConfigured()).toBe(false);
    process.env.CURF_ENGINE_SIGNING_KEY_PREVIOUS = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(engineIdentityConfigured()).toBe(false);
  });
});
