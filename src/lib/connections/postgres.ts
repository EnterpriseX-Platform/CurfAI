/**
 * Postgres connection helpers.
 *
 * `DataSource.connection` for kind="postgres" is JSON of shape:
 *   {
 *     host: string,
 *     port: number,         // typically 5432
 *     database: string,
 *     user: string,
 *     passwordEnc: string,  // AES-256-GCM via lib/secrets.ts
 *     schema?: string,      // default "public"
 *     ssl?: boolean | { rejectUnauthorized: boolean },
 *   }
 *
 * The plaintext password never lives on disk — only the AES-encrypted blob.
 * Decryption happens here, at query time and connection-test time, never in
 * routes that serve the connection back to the client. The GET /api/data-sources
 * route MASKS the password before returning, mirroring the Anthropic-key flow.
 *
 * v1 only does host/port connections + plain password auth + optional SSL.
 * Service-account / IAM / SSH-tunnel auth are deferred until a customer asks.
 */
import type { ClientConfig } from "pg";
import { encryptSecret, decryptSecret } from "@/lib/secrets";

export type PgConnectionInput = {
  host: string;
  port?: number;
  database: string;
  user: string;
  /** Plaintext, only on the way IN to be encrypted. Never stored. */
  password?: string;
  schema?: string;
  ssl?: boolean;
};

export type PgConnectionStored = {
  host: string;
  port: number;
  database: string;
  user: string;
  /** AES-256-GCM ciphertext (base64). */
  passwordEnc: string;
  schema: string;
  ssl: boolean;
};

/**
 * Encode a plaintext input into the JSON-encoded shape stored in
 * DataSource.connection. Encrypts the password. If `existingJson` is supplied
 * and the input has no password, the existing encrypted password is reused —
 * lets PATCH avoid round-tripping the plaintext through the client.
 */
export function encodePgConnection(input: PgConnectionInput, existingJson?: string | null): string {
  let existingPasswordEnc: string | null = null;
  if (existingJson) {
    try {
      const prev = JSON.parse(existingJson) as Partial<PgConnectionStored>;
      existingPasswordEnc = prev.passwordEnc ?? null;
    } catch { /* corrupt — ignore, force new password */ }
  }
  let passwordEnc: string;
  if (input.password && input.password.length > 0) {
    passwordEnc = encryptSecret(input.password);
  } else if (existingPasswordEnc) {
    passwordEnc = existingPasswordEnc;
  } else {
    throw new Error("Password is required for new Postgres connections.");
  }
  const stored: PgConnectionStored = {
    host: input.host.trim(),
    port: Number.isFinite(input.port) ? Number(input.port) : 5432,
    database: input.database.trim(),
    user: input.user.trim(),
    passwordEnc,
    schema: (input.schema ?? "public").trim() || "public",
    ssl: !!input.ssl,
  };
  return JSON.stringify(stored);
}

/**
 * Decode the JSON connection field back to a typed object. Does NOT
 * decrypt the password — caller asks for that explicitly via
 * resolvePgClientConfig() so we keep plaintext in memory for as short a
 * window as possible.
 */
export function decodePgConnection(json: string): PgConnectionStored {
  const parsed = JSON.parse(json) as Partial<PgConnectionStored>;
  if (!parsed.host || !parsed.database || !parsed.user || !parsed.passwordEnc) {
    throw new Error("Postgres connection JSON is missing required fields.");
  }
  return {
    host: parsed.host,
    port: Number.isFinite(parsed.port) ? Number(parsed.port) : 5432,
    database: parsed.database,
    user: parsed.user,
    passwordEnc: parsed.passwordEnc,
    schema: parsed.schema ?? "public",
    ssl: !!parsed.ssl,
  };
}

/**
 * Convert a stored connection into a `pg.ClientConfig` ready to construct a
 * Client with. Decrypts the password just in time — caller must close the
 * client when finished so the plaintext is GC'd.
 */
export function resolvePgClientConfig(stored: PgConnectionStored): ClientConfig {
  const password = decryptSecret(stored.passwordEnc);
  if (password == null) {
    // Either CURF_SECRET_KEY is missing/changed, or the cipher blob is
    // corrupt. Fail loudly here — the runner / test endpoints catch and
    // surface this to the user as "decryption failed; please re-enter the
    // password".
    throw new Error("Could not decrypt Postgres password. Re-enter it under Connections → Edit.");
  }
  return {
    host: stored.host,
    port: stored.port,
    database: stored.database,
    user: stored.user,
    password,
    ssl: stored.ssl ? { rejectUnauthorized: false } : undefined,
    // Statement timeout (ms) — keeps a misbehaving SELECT from hanging the
    // viewer indefinitely. Tunable per-tenant later if customers need
    // long-running queries.
    statement_timeout: 15_000,
    connectionTimeoutMillis: 5_000,
  };
}

/**
 * Hide the password before echoing the connection back to the client. Used
 * by GET /api/data-sources/[id] so admins editing the connection don't see
 * the secret. New password input replaces; empty input keeps existing.
 */
export function maskPgConnectionForClient(json: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  schema: string;
  ssl: boolean;
  hasPassword: boolean;
} {
  const stored = decodePgConnection(json);
  return {
    host: stored.host,
    port: stored.port,
    database: stored.database,
    user: stored.user,
    schema: stored.schema,
    ssl: stored.ssl,
    hasPassword: !!stored.passwordEnc,
  };
}
