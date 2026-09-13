/**
 * Embed-token signing/verification.
 *
 * An embed token is a tenant-scoped capability that lets an external page
 * render one specific block from one specific report. The generic HMAC
 * sign/verify envelope lives in `lib/security/capabilityToken.ts` (shared
 * with the C4 document-download token) — this file owns only the
 * report/block-specific payload shape and required-field check.
 *
 * Format: `<base64url(payload)>.<base64url(hmac)>`
 *
 * Payload fields:
 *   t   tenantId  — scopes the data the token can read
 *   r   reportId
 *   b   blockId
 *   p   params    — frozen filter values applied at render time
 *   exp expiresAt — unix ms
 */
import { signCapabilityToken, verifyCapabilityToken } from "@/lib/security/capabilityToken";

export type EmbedTokenPayload = {
  t: string;        // tenantId
  r: string;        // reportId
  b: string;        // blockId
  p?: Record<string, unknown>; // frozen params (optional)
  exp: number;      // unix ms
};

export function signEmbedToken(payload: EmbedTokenPayload): string {
  return signCapabilityToken(payload);
}

/**
 * Verify + parse. Returns null on bad signature or expiry. Caller MUST
 * still check that the payload's reportId/blockId match the URL — the
 * token is otherwise reusable across blocks.
 */
export function verifyEmbedToken(token: string): EmbedTokenPayload | null {
  const payload = verifyCapabilityToken<EmbedTokenPayload>(token);
  if (!payload) return null;
  if (!payload.t || !payload.r || !payload.b) return null;
  return payload;
}

/** Build a signed token with a TTL in days (default 365). */
export function mintEmbedToken(opts: {
  tenantId: string; reportId: string; blockId: string;
  params?: Record<string, unknown>; ttlDays?: number;
}): string {
  return signEmbedToken({
    t: opts.tenantId,
    r: opts.reportId,
    b: opts.blockId,
    p: opts.params,
    exp: Date.now() + (opts.ttlDays ?? 365) * 86400_000,
  });
}
