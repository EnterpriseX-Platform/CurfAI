/**
 * Curf as the identity provider the Java engine trusts (engines/java).
 *
 * The engine only accepts signed tokens naming a person, their workspace and their roles. Curf signs one per
 * query, as the person running it, valid for a minute. The engine fetches the public half from
 * GET /api/engine/jwks and checks every token against it, so the engine never holds anything that could
 * mint a token itself.
 *
 * RS256 with node:crypto, like lib/security/capabilityToken.ts avoids a JWT dependency. The private key is
 * operator-held (CURF_ENGINE_SIGNING_KEY, a PKCS#8 PEM); there is no default and no fallback to another
 * secret, so an engine is never trusting a key that was derived from something else.
 *
 * Engine-side settings that go with this (engines/README.md):
 *   CURF_ENGINE_SECURITY_ISSUERS_0_ISSUER   = the value of engineIssuer()
 *   CURF_ENGINE_SECURITY_ISSUERS_0_JWKSETURI = <Curf>/api/engine/jwks
 *   CURF_ENGINE_SECURITY_CLAIMS_TENANT      = tenant
 */
import { createHash, createPrivateKey, createPublicKey, createSign, randomUUID, type KeyObject } from "node:crypto";

/** What the engine needs to know about the person, as the runner has it (RunViewer in lib/reporting/runner.ts). */
export type EngineViewer = { id: string; isAdmin: boolean; roles: string[] };

export const ENGINE_TOKEN_TTL_SECONDS = 60;

type Signer = { privateKey: KeyObject; kid: string; jwk: Record<string, unknown> };

let cached: { pem: string; signer: Signer } | null = null;

function normalisePem(raw: string): string {
  // Env files and secret stores often carry the key on one line with literal \n.
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function loadSigner(): Signer | null {
  const raw = process.env.CURF_ENGINE_SIGNING_KEY;
  if (!raw || !raw.trim()) return null;
  const pem = normalisePem(raw.trim());
  if (cached && cached.pem === pem) return cached.signer;

  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error("CURF_ENGINE_SIGNING_KEY must be an RSA private key (PKCS#8 PEM).");
  }
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" }) as { n?: string; e?: string };
  // RFC 7638 thumbprint, so the key id changes exactly when the key does.
  const kid = createHash("sha256")
    .update(JSON.stringify({ e: publicJwk.e, kty: "RSA", n: publicJwk.n }))
    .digest("base64url")
    .slice(0, 16);
  const signer: Signer = { privateKey, kid, jwk: { ...publicJwk, kid, alg: "RS256", use: "sig" } };
  cached = { pem, signer };
  return signer;
}

/** True when this Curf can vouch for people to an engine. */
export function engineIdentityConfigured(): boolean {
  try {
    return loadSigner() !== null;
  } catch {
    return false;
  }
}

/** The `iss` the engine must be configured to trust. */
export function engineIssuer(): string {
  const issuer = process.env.CURF_ENGINE_ISSUER || process.env.NEXTAUTH_URL || "";
  return issuer.replace(/\/$/, "");
}

/** The public key set the engine fetches. Null when no signing key is configured. */
export function engineJwks(): { keys: Record<string, unknown>[] } | null {
  const signer = loadSigner();
  return signer ? { keys: [signer.jwk] } : null;
}

/**
 * Roles as the engine knows them. Curf's custom role slugs pass through unchanged, because a view's
 * `allowedRoles` / `piiRoles` name them; Curf's admin becomes the engine's `curf-admin` inside this
 * workspace only (the tenant claim confines it), everyone else is a plain `curf-viewer`.
 */
export function engineRolesFor(viewer: EngineViewer): string[] {
  const roles = new Set<string>(viewer.roles.filter((r) => typeof r === "string" && r.length > 0));
  roles.add(viewer.isAdmin ? "curf-admin" : "curf-viewer");
  return [...roles];
}

const b64 = (value: string | object) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/**
 * A signed token for one person in one workspace. Short-lived and never stored or logged; callers must
 * keep it out of error messages.
 */
export function mintEngineToken(opts: {
  viewer: EngineViewer;
  tenantId: string;
  audience?: string;
  nowMs?: number;
}): string {
  const signer = loadSigner();
  if (!signer) throw new Error("The Java engine is not set up on this Curf (CURF_ENGINE_SIGNING_KEY is missing).");
  const issuer = engineIssuer();
  if (!issuer) throw new Error("The engine token needs an issuer: set CURF_ENGINE_ISSUER or NEXTAUTH_URL.");

  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const claims: Record<string, unknown> = {
    iss: issuer,
    sub: opts.viewer.id,
    preferred_username: opts.viewer.id,
    iat: now,
    nbf: now - 5,
    exp: now + ENGINE_TOKEN_TTL_SECONDS,
    jti: randomUUID(),
    tenant: opts.tenantId,
    realm_access: { roles: engineRolesFor(opts.viewer) },
  };
  if (opts.audience) claims.aud = opts.audience;

  const signingInput = `${b64({ alg: "RS256", typ: "JWT", kid: signer.kid })}.${b64(claims)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(signer.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}
