/**
 * Pairing codes for On Screen displays: a short code an admin reads out and
 * a wall screen types in, instead of pasting a 43-character kiosk token.
 *
 * The alphabet leaves out 0/O and 1/I/L, which look alike on a TV across a
 * room. 8 characters of 31 is about 8.5e11 codes; with a 10-minute life,
 * single use and a per-address attempt limit on the redeem route, guessing
 * a live one is not practical. Only a hash is stored.
 */
import { createHash, randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 10 * 60_000;

export function generatePairingCode(): string {
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** What a person typed, reduced to the code's own characters (case, spaces and dashes ignored); null if it cannot be a code. */
export function normalizePairingCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** "ABCD-EFGH", the way it is shown. */
export function displayPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
