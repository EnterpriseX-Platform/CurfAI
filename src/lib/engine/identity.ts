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

/**
 * What the engine needs to know about the person, as the runner has it (RunViewer in lib/reporting/runner.ts).
 * `anonymous` is a visitor with no account (a public link): they are the engine's reserved role `public` and
 * nothing else, so the engine serves them only the views someone explicitly marked public.
 */
export type EngineViewer = { id: string; isAdmin: boolean; roles: string[]; anonymous?: boolean };

/** Who the engine sees an anonymous visitor as. The workspace's own claim confines it to that workspace. */
export const ENGINE_ANONYMOUS_SUBJECT = "public:anonymous";

export const ENGINE_TOKEN_TTL_SECONDS = 60;

type Jwk = Record<string, unknown>;
type Signer = { privateKey: KeyObject; kid: string; jwk: Jwk; previous: Jwk[] };

let cached: { cacheKey: string; signer: Signer } | null = null;

function normalisePem(raw: string): string {
  // Env files and secret stores often carry the key on one line with literal \n.
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

/** The public key as a JWK, with an RFC 7638 thumbprint as its id, so the id changes exactly when the key does. */
function publicJwkOf(key: KeyObject): { kid: string; jwk: Jwk } {
  // createPublicKey derives from a private key but refuses one that is already public (a retired key's half).
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  const publicJwk = publicKey.export({ format: "jwk" }) as { n?: string; e?: string };
  const kid = createHash("sha256")
    .update(JSON.stringify({ e: publicJwk.e, kty: "RSA", n: publicJwk.n }))
    .digest("base64url")
    .slice(0, 16);
  return { kid, jwk: { ...publicJwk, kid, alg: "RS256", use: "sig" } };
}

/**
 * Keys that are being retired. Rotating the signing key without downtime means the engine must keep accepting
 * tokens signed by the old key until they expire (a minute) and the engine has re-read the key set, so the old
 * key's PUBLIC half stays in the published set for a while. CURF_ENGINE_SIGNING_KEY_PREVIOUS holds one or more
 * PEM blocks (a private or a public key each); only their public halves are ever published, and they never sign.
 */
function loadPrevious(raw: string | undefined, currentKid: string): Jwk[] {
  if (!raw || !raw.trim()) return [];
  const blocks = normalisePem(raw).match(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g) ?? [];
  if (blocks.length === 0) throw new Error("CURF_ENGINE_SIGNING_KEY_PREVIOUS holds no PEM block.");
  const out: Jwk[] = [];
  for (const block of blocks) {
    const key = createPublicKey(block);
    if (key.asymmetricKeyType !== "rsa") throw new Error("CURF_ENGINE_SIGNING_KEY_PREVIOUS must hold RSA keys.");
    const { kid, jwk } = publicJwkOf(key);
    if (kid !== currentKid && !out.some((j) => j.kid === kid)) out.push(jwk);
  }
  return out;
}

function loadSigner(): Signer | null {
  const raw = process.env.CURF_ENGINE_SIGNING_KEY;
  if (!raw || !raw.trim()) return null;
  const pem = normalisePem(raw.trim());
  const previousRaw = process.env.CURF_ENGINE_SIGNING_KEY_PREVIOUS;
  const cacheKey = `${pem}\u0000${previousRaw ?? ""}`;
  if (cached && cached.cacheKey === cacheKey) return cached.signer;

  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error("CURF_ENGINE_SIGNING_KEY must be an RSA private key (PKCS#8 PEM).");
  }
  const { kid, jwk } = publicJwkOf(privateKey);
  const signer: Signer = { privateKey, kid, jwk, previous: loadPrevious(previousRaw, kid) };
  cached = { cacheKey, signer };
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

/** The public key set the engine fetches: the current key first, then any being retired. Null when none is configured. */
export function engineJwks(): { keys: Record<string, unknown>[] } | null {
  const signer = loadSigner();
  return signer ? { keys: [signer.jwk, ...signer.previous] } : null;
}

/**
 * The engine's own role names. A Curf custom role may not take them: `curf-*` carry engine permissions (admin,
 * approver…) and `public` is the anonymous reader. Without this, a workspace admin could create a custom role
 * called `curf-approver` and the person holding it would approve the engine's publish requests.
 */
export function isReservedEngineRole(role: string): boolean {
  const r = role.trim().toLowerCase();
  return r.startsWith("curf-") || r === "public";
}

/**
 * Roles as the engine knows them. Curf's custom role slugs pass through, because a view's `allowedRoles` /
 * `piiRoles` name them — except the engine's reserved names, which are dropped. Curf's admin becomes the
 * engine's `curf-admin` inside this workspace only (the tenant claim confines it), everyone else is a plain
 * `curf-viewer`.
 */
export function engineRolesFor(viewer: EngineViewer): string[] {
  // A visitor with no account is `public`, and nothing else: not a viewer, and never holding a custom role. The
  // engine guarantees (when a view is saved) that a view offered to `public` has no row rules and no unmasked
  // personal data, so this is the whole of what an anonymous reader can reach.
  if (viewer.anonymous) return ["public"];
  const roles = new Set<string>(viewer.roles.filter((r) => typeof r === "string" && r.length > 0 && !isReservedEngineRole(r)));
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
  // Whatever id an anonymous viewer carries, the engine knows them only as the public.
  const subject = opts.viewer.anonymous ? ENGINE_ANONYMOUS_SUBJECT : opts.viewer.id;
  const claims: Record<string, unknown> = {
    iss: issuer,
    sub: subject,
    preferred_username: subject,
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
