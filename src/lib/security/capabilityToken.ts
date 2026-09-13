/**
 * Generic signed-capability-token envelope — extracted from
 * `lib/embed/token.ts` so a second capability (the C4 document-download
 * link) doesn't reimplement the same HMAC logic. This module knows nothing
 * about payload shape or which fields are required; callers own that.
 *
 * Format: `<base64url(payload)>.<base64url(hmac)>`
 *
 * Why HMAC instead of a JWT lib: JWT brings JWS algorithm sprawl + a
 * dependency. We control both signer and verifier; a homemade envelope
 * keeps the audit story short.
 */
import crypto from "node:crypto";

function getSecret(): string {
  return process.env.CURF_EMBED_SECRET || process.env.AUTH_SECRET || "curf-embed-dev-secret-change-me";
}

function b64u(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

export function signCapabilityToken<T extends { exp: number }>(payload: T): string {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", getSecret()).update(body).digest();
  return `${body}.${b64u(sig)}`;
}

/**
 * Verify + parse. Returns null on bad signature or expiry. Does NOT check
 * that any payload field other than `exp` is present — the caller owns
 * required-field validation for its own payload shape.
 */
export function verifyCapabilityToken<T extends { exp: number }>(token: string): T | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64u(crypto.createHmac("sha256", getSecret()).update(body).digest());
  // Constant-time compare so we don't leak timing info on the prefix length.
  if (expected.length !== sig.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  } catch {
    return null;
  }
  let payload: T;
  try {
    payload = JSON.parse(b64uDecode(body).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload?.exp !== "number" || payload.exp < Date.now()) return null;
  return payload;
}
