/**
 * Embed tokens are unauthenticated bearer capabilities — anyone who has one
 * can render the report/block it names, forever (or until expiry), with no
 * session check. sign/verify/mint had zero test coverage despite being the
 * only thing standing between "read this JSON" and "read any tenant's
 * report data by guessing/reusing a token."
 */
import { describe, it, expect } from "vitest";
import { signEmbedToken, verifyEmbedToken, mintEmbedToken, type EmbedTokenPayload } from "./token";

function payload(overrides: Partial<EmbedTokenPayload> = {}): EmbedTokenPayload {
  return { t: "tenant1", r: "report1", b: "block1", exp: Date.now() + 60_000, ...overrides };
}

describe("signEmbedToken / verifyEmbedToken round-trip", () => {
  it("a freshly signed token verifies and returns the exact payload", () => {
    const p = payload();
    const token = signEmbedToken(p);
    expect(verifyEmbedToken(token)).toEqual(p);
  });

  it("carries frozen params through the round-trip", () => {
    const p = payload({ p: { region: "APAC", minRevenue: 1000 } });
    const token = signEmbedToken(p);
    expect(verifyEmbedToken(token)?.p).toEqual({ region: "APAC", minRevenue: 1000 });
  });
});

describe("verifyEmbedToken — rejects tampering and malformed input", () => {
  it("rejects a token with a flipped signature byte", () => {
    const token = signEmbedToken(payload());
    const [body, sig] = token.split(".");
    const tamperedSig = sig.slice(0, -1) + (sig.at(-1) === "A" ? "B" : "A");
    expect(verifyEmbedToken(`${body}.${tamperedSig}`)).toBeNull();
  });

  it("rejects a token whose payload was edited without re-signing (tenant swap attempt)", () => {
    const token = signEmbedToken(payload({ t: "victim-tenant" }));
    const [, sig] = token.split(".");
    const forgedBody = Buffer.from(JSON.stringify(payload({ t: "attacker-tenant" })))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(verifyEmbedToken(`${forgedBody}.${sig}`)).toBeNull();
  });

  it("rejects malformed tokens (no dot, empty, garbage)", () => {
    expect(verifyEmbedToken("")).toBeNull();
    expect(verifyEmbedToken("not-a-token")).toBeNull();
    expect(verifyEmbedToken(".onlysig")).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signEmbedToken(payload({ exp: Date.now() - 1000 }));
    expect(verifyEmbedToken(token)).toBeNull();
  });

  it("rejects a token missing required fields even with a valid signature", () => {
    // Sign a payload missing `b` — TypeScript would normally stop this at
    // the call site, but the wire format has no schema enforcement once
    // it's a token string, so runtime defense matters here too.
    const token = signEmbedToken({ t: "tenant1", r: "report1", exp: Date.now() + 60_000 } as any);
    expect(verifyEmbedToken(token)).toBeNull();
  });
});

describe("mintEmbedToken", () => {
  it("mints a token that verifies with the given scope", () => {
    const token = mintEmbedToken({ tenantId: "t1", reportId: "r1", blockId: "b1" });
    const decoded = verifyEmbedToken(token);
    expect(decoded).toMatchObject({ t: "t1", r: "r1", b: "b1" });
  });

  it("defaults to a ~365-day TTL", () => {
    const before = Date.now();
    const token = mintEmbedToken({ tenantId: "t1", reportId: "r1", blockId: "b1" });
    const decoded = verifyEmbedToken(token)!;
    const impliedTtlDays = (decoded.exp - before) / 86_400_000;
    expect(impliedTtlDays).toBeGreaterThan(364);
    expect(impliedTtlDays).toBeLessThanOrEqual(366);
  });

  it("honors a custom ttlDays", () => {
    const token = mintEmbedToken({ tenantId: "t1", reportId: "r1", blockId: "b1", ttlDays: 1 });
    const decoded = verifyEmbedToken(token)!;
    const impliedTtlDays = (decoded.exp - Date.now()) / 86_400_000;
    expect(impliedTtlDays).toBeGreaterThan(0.9);
    expect(impliedTtlDays).toBeLessThanOrEqual(1.01);
  });
});
