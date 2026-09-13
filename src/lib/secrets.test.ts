/**
 * AES-256-GCM roundtrip + tamper-detection coverage for lib/secrets.ts —
 * every connector's password/credential encryption bottoms out here.
 */
import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret, maskKey } from "./secrets";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext value", () => {
    const encoded = encryptSecret("hunter2-super-secret");
    expect(decryptSecret(encoded)).toBe("hunter2-super-secret");
  });

  it("never stores the plaintext inside the encoded blob", () => {
    const encoded = encryptSecret("hunter2-super-secret");
    expect(encoded).not.toContain("hunter2-super-secret");
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-input");
    expect(decryptSecret(b)).toBe("same-input");
  });

  it("returns null (not a throw, not the plaintext) when the ciphertext is tampered with", () => {
    const encoded = encryptSecret("hunter2-super-secret");
    const [iv, tag, ct] = encoded.split(":");
    const tampered = [iv, tag, ct.slice(0, -2) + "xx"].join(":");
    expect(decryptSecret(tampered)).toBeNull();
  });

  it("returns null for malformed input instead of throwing", () => {
    expect(decryptSecret("not-a-valid-blob")).toBeNull();
    expect(decryptSecret("")).toBeNull();
  });
});

describe("maskKey", () => {
  it("shows only the prefix and last 4 characters", () => {
    const masked = maskKey("sk-ant-api03-abcdefghijklmnopqrstuvwxyz123");
    expect(masked.startsWith("sk-ant-api03")).toBe(true);
    expect(masked.endsWith("z123")).toBe(true);
    expect(masked).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("fully redacts short keys instead of exposing them whole", () => {
    expect(maskKey("short")).toBe("•••");
  });

  it("returns empty string for empty input", () => {
    expect(maskKey("")).toBe("");
  });
});
