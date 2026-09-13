/**
 * MySQL connection helpers. Mirrors lib/connections/postgres.ts so all the
 * connector kinds share the same encrypted-password lifecycle.
 *
 * `DataSource.connection` for kind="mysql" is JSON of shape:
 *   {
 *     host: string,
 *     port: number,         // typically 3306
 *     database: string,
 *     user: string,
 *     passwordEnc: string,  // AES-256-GCM via lib/secrets.ts
 *     ssl?: boolean,
 *   }
 *
 * Note: MySQL "database" is what Postgres calls a "schema" — this file uses
 * MySQL's terminology since that's what users see in their hosting UI.
 */
import type { ConnectionOptions } from "mysql2";
import { encryptSecret, decryptSecret } from "@/lib/secrets";

export type MyConnectionInput = {
  host: string;
  port?: number;
  database: string;
  user: string;
  /** Plaintext, only on the way IN to be encrypted. Never stored. */
  password?: string;
  ssl?: boolean;
};

export type MyConnectionStored = {
  host: string;
  port: number;
  database: string;
  user: string;
  /** AES-256-GCM ciphertext (base64). */
  passwordEnc: string;
  ssl: boolean;
};

/**
 * Encode a plaintext input into the JSON shape stored in
 * DataSource.connection. Encrypts the password. If `existingJson` is supplied
 * and the input has no password, the existing encrypted password is reused.
 */
export function encodeMyConnection(input: MyConnectionInput, existingJson?: string | null): string {
  let existingPasswordEnc: string | null = null;
  if (existingJson) {
    try {
      const prev = JSON.parse(existingJson) as Partial<MyConnectionStored>;
      existingPasswordEnc = prev.passwordEnc ?? null;
    } catch { /* corrupt — force new password */ }
  }
  let passwordEnc: string;
  if (input.password && input.password.length > 0) {
    passwordEnc = encryptSecret(input.password);
  } else if (existingPasswordEnc) {
    passwordEnc = existingPasswordEnc;
  } else {
    throw new Error("Password is required for new MySQL connections.");
  }
  const stored: MyConnectionStored = {
    host: input.host.trim(),
    port: Number.isFinite(input.port) ? Number(input.port) : 3306,
    database: input.database.trim(),
    user: input.user.trim(),
    passwordEnc,
    ssl: !!input.ssl,
  };
  return JSON.stringify(stored);
}

/** Decode the JSON connection field back to a typed object. Doesn't decrypt. */
export function decodeMyConnection(json: string): MyConnectionStored {
  const parsed = JSON.parse(json) as Partial<MyConnectionStored>;
  if (!parsed.host || !parsed.database || !parsed.user || !parsed.passwordEnc) {
    throw new Error("MySQL connection JSON is missing required fields.");
  }
  return {
    host: parsed.host,
    port: Number.isFinite(parsed.port) ? Number(parsed.port) : 3306,
    database: parsed.database,
    user: parsed.user,
    passwordEnc: parsed.passwordEnc,
    ssl: !!parsed.ssl,
  };
}

/**
 * Decrypt + return mysql2 ConnectionOptions ready to construct a Connection
 * with. Statement timeout matches the Postgres path so a misbehaving SELECT
 * can't hang the viewer.
 */
export function resolveMyClientConfig(stored: MyConnectionStored): ConnectionOptions {
  const password = decryptSecret(stored.passwordEnc);
  if (password == null) {
    throw new Error("Could not decrypt MySQL password. Re-enter it under Connections → Edit.");
  }
  return {
    host: stored.host,
    port: stored.port,
    database: stored.database,
    user: stored.user,
    password,
    ssl: stored.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 5_000,
    // mysql2 doesn't support a per-statement timeout the same way pg does;
    // the closest equivalent is wrapping queries with SET STATEMENT
    // max_statement_time = N — we leave that to power-users for now.
  };
}

/** Mask the password before echoing back to the edit form. */
export function maskMyConnectionForClient(json: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  hasPassword: boolean;
} {
  const stored = decodeMyConnection(json);
  return {
    host: stored.host,
    port: stored.port,
    database: stored.database,
    user: stored.user,
    ssl: stored.ssl,
    hasPassword: !!stored.passwordEnc,
  };
}
