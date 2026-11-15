import { describe, it, expect } from "vitest";
import { generatePairingCode, normalizePairingCode, hashPairingCode, displayPairingCode, PAIRING_CODE_LENGTH } from "./pairing";

describe("pairing codes", () => {
  it("generates codes the normaliser accepts, of the fixed length", () => {
    for (let i = 0; i < 200; i++) {
      const c = generatePairingCode();
      expect(c).toHaveLength(PAIRING_CODE_LENGTH);
      expect(normalizePairingCode(c)).toBe(c);
    }
  });
  it("reads what a person types: any case, spaces and dashes", () => {
    expect(normalizePairingCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizePairingCode(" ab cd ef gh ")).toBe("ABCDEFGH");
  });
  it("rejects wrong length and look-alike characters", () => {
    expect(normalizePairingCode("ABCDEFG")).toBeNull();
    expect(normalizePairingCode("ABCDEFGHJ")).toBeNull();
    expect(normalizePairingCode("ABCD0FGH")).toBeNull();
    expect(normalizePairingCode("ABCD1FGH")).toBeNull();
  });
  it("hashes the same code to the same value and shows it in two groups", () => {
    expect(hashPairingCode("ABCDEFGH")).toBe(hashPairingCode("ABCDEFGH"));
    expect(hashPairingCode("ABCDEFGH")).not.toBe(hashPairingCode("ABCDEFGJ"));
    expect(displayPairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });
});
