/**
 * Generic HMAC envelope extracted from embed/token.ts (see that file's own
 * token.test.ts for the payload-specific coverage). This tests the
 * envelope mechanics alone: sign/verify round-trip, tamper detection,
 * expiry — with zero assumptions about payload shape, since two capability
 * kinds (embed tokens, C4 document tokens) now share this primitive.
 */
import { describe, it, expect } from "vitest";
import { signCapabilityToken, verifyCapabilityToken } from "./capabilityToken";

type Payload = { t: string; doc: string; exp: number };

function payload(overrides: Partial<Payload> = {}): Payload {
  return { t: "tenant1", doc: "doc1", exp: Date.now() + 60_000, ...overrides };
}

describe("signCapabilityToken / verifyCapabilityToken round-trip", () => {
  it("a freshly signed token verifies and returns the exact payload", () => {
    const p = payload();
    const token = signCapabilityToken(p);
    expect(verifyCapabilityToken<Payload>(token)).toEqual(p);
  });

  it("works with a completely different payload shape (generic, not embed-specific)", () => {
    const p = { kind: "whatever", n: 42, exp: Date.now() + 60_000 };
    const token = signCapabilityToken(p);
    expect(verifyCapabilityToken<typeof p>(token)).toEqual(p);
  });
});

describe("verifyCapabilityToken — rejects tampering and malformed input", () => {
  it("rejects a token with a flipped signature byte", () => {
    const token = signCapabilityToken(payload());
    const [body, sig] = token.split(".");
    const tamperedSig = sig.slice(0, -1) + (sig.at(-1) === "A" ? "B" : "A");
    expect(verifyCapabilityToken(`${body}.${tamperedSig}`)).toBeNull();
  });

  it("rejects a token whose payload was edited without re-signing", () => {
    const token = signCapabilityToken(payload({ t: "victim-tenant" }));
    const [, sig] = token.split(".");
    const forgedBody = Buffer.from(JSON.stringify(payload({ t: "attacker-tenant" })))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(verifyCapabilityToken(`${forgedBody}.${sig}`)).toBeNull();
  });

  it("rejects malformed tokens (no dot, empty, garbage)", () => {
    expect(verifyCapabilityToken("")).toBeNull();
    expect(verifyCapabilityToken("not-a-token")).toBeNull();
    expect(verifyCapabilityToken(".onlysig")).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signCapabilityToken(payload({ exp: Date.now() - 1000 }));
    expect(verifyCapabilityToken(token)).toBeNull();
  });

  it("rejects a token with no exp field at all", () => {
    const token = signCapabilityToken({ t: "tenant1", doc: "doc1" } as any);
    expect(verifyCapabilityToken(token)).toBeNull();
  });
});
