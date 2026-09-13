/**
 * One-time migration: re-encrypt every AES-256-GCM secret currently
 * encrypted under CURF_SECRET_KEY's fallback derivation, to the real
 * CURF_SECRET_KEY value.
 *
 * Why format-based scanning instead of a column allowlist: encrypted
 * values live in two shapes across this schema —
 *   (a) dedicated columns, e.g. Tenant.llmKeyEnc, Tenant.anthropicKeyEnc,
 *       SlackWorkspace.botTokenEnc, ExternalTable.credentialsEnc
 *   (b) nested inside JSON blobs stored in generic TEXT columns, e.g.
 *       DataSource.connection (mysql/postgres/snowflake/bigquery/rest
 *       connectors each JSON.stringify a config object with a
 *       passwordEnc/credentialsEnc/headersEnc key inside it),
 *       BackupDestination.configJson (dynamic "<field>__enc" keys)
 * A fixed column-name list would miss (b) entirely. Instead this walks
 * EVERY text/varchar column in the database, and for each value: if it
 * matches the exact ciphertext format, treat it as a leaf; if it parses
 * as JSON, recursively walk every string leaf the same way.
 *
 * Ciphertext format (see lib/secrets.ts): base64url(iv):base64url(tag):base64url(ct)
 *
 * Usage:
 *   DATABASE_URL=... OLD_KEY_SOURCE=fallback NEW_SECRET_KEY=... node scripts/migrate-secret-key.js [--apply]
 *
 * Without --apply: dry run, reports what WOULD change, writes nothing.
 * With --apply: runs inside a single transaction; any single failure
 * rolls back the entire migration (all-or-nothing, never a half-migrated DB).
 *
 * Idempotent: a leaf that already decrypts under NEW_SECRET_KEY is left
 * alone (lets this be safely re-run, e.g. after fixing an error and retrying).
 */
const { Client } = require("pg");
const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require("crypto");

const APPLY = process.argv.includes("--apply");
const SALT = "curf-secrets-v1"; // must match lib/secrets.ts exactly
const OLD_PASSPHRASE = process.env.OLD_SECRET_KEY || "curf-dev-secret-please-override-in-prod";
const NEW_PASSPHRASE = process.env.NEW_SECRET_KEY;

if (!NEW_PASSPHRASE) {
  console.error("NEW_SECRET_KEY env var is required (the real CURF_SECRET_KEY value to migrate TO).");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL env var is required.");
  process.exit(1);
}

function deriveKey(passphrase) {
  return scryptSync(passphrase, SALT, 32);
}
const OLD_KEY = deriveKey(OLD_PASSPHRASE);
const NEW_KEY = deriveKey(NEW_PASSPHRASE);

function b64url(buf) { return buf.toString("base64url"); }
function fromB64url(s) { return Buffer.from(s, "base64url"); }

function decryptWith(key, encoded) {
  try {
    const [ivB, tagB, ctB] = encoded.split(":");
    if (!ivB || !tagB || !ctB) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, fromB64url(ivB));
    decipher.setAuthTag(fromB64url(tagB));
    const pt = Buffer.concat([decipher.update(fromB64url(ctB)), decipher.final()]);
    return pt.toString("utf8");
  } catch { return null; }
}
function encryptWith(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return b64url(iv) + ":" + b64url(tag) + ":" + b64url(ct);
}

// Ciphertext shape: three base64url segments separated by ':'. Cheap
// pre-filter before attempting an actual decrypt (which is the real test).
const CIPHERTEXT_SHAPE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

const stats = {
  columnsScanned: 0,
  rowsChanged: 0,
  leavesMigrated: 0,
  alreadyMigrated: 0,
  undecryptableAnomalies: [], // values that look like ciphertext but decrypt under NEITHER key
};

/**
 * Recursively walk a JSON value, re-encrypting any string leaf that looks
 * like our ciphertext format. Returns { value, changed }.
 */
function walkAndMigrate(value, pathForLog) {
  if (typeof value === "string") {
    if (!CIPHERTEXT_SHAPE.test(value)) return { value, changed: false };
    // Already migrated? (decrypts under the NEW key already)
    if (decryptWith(NEW_KEY, value) !== null) {
      stats.alreadyMigrated++;
      return { value, changed: false };
    }
    const plain = decryptWith(OLD_KEY, value);
    if (plain === null) {
      stats.undecryptableAnomalies.push(pathForLog);
      return { value, changed: false };
    }
    stats.leavesMigrated++;
    return { value: encryptWith(NEW_KEY, plain), changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v, i) => {
      const r = walkAndMigrate(v, `${pathForLog}[${i}]`);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: out, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out = {};
    for (const k of Object.keys(value)) {
      const r = walkAndMigrate(value[k], `${pathForLog}.${k}`);
      if (r.changed) changed = true;
      out[k] = r.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

/** Top-level column value: either a raw ciphertext string, or JSON text containing leaves. */
function migrateColumnValue(raw, pathForLog) {
  if (raw == null) return { value: raw, changed: false };
  if (CIPHERTEXT_SHAPE.test(raw)) {
    return walkAndMigrate(raw, pathForLog);
  }
  // Try JSON — most columns are plain text (names, SQL, descriptions) and
  // will fail to parse or parse to a non-object/array; that's expected and
  // silently skipped, not an error.
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { value: raw, changed: false }; }
  if (parsed === null || typeof parsed !== "object") return { value: raw, changed: false };
  const { value, changed } = walkAndMigrate(parsed, pathForLog);
  if (!changed) return { value: raw, changed: false };
  return { value: JSON.stringify(value), changed: true };
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    if (APPLY) await client.query("BEGIN");

    const { rows: columns } = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('text', 'character varying')
      ORDER BY table_name, column_name
    `);

    for (const { table_name, column_name } of columns) {
      stats.columnsScanned++;
      // Every real model here uses "id" as its PK column name.
      const { rows: idCols } = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'
      `, [table_name]);
      if (idCols.length === 0) continue; // no id column, skip (join tables etc.)

      const { rows } = await client.query(
        `SELECT id, "${column_name}" AS val FROM "${table_name}" WHERE "${column_name}" IS NOT NULL`
      );

      for (const row of rows) {
        const pathForLog = `${table_name}.${column_name}#${row.id}`;
        const { value: newVal, changed } = migrateColumnValue(row.val, pathForLog);
        if (!changed) continue;
        stats.rowsChanged++;
        console.log(`[${APPLY ? "APPLY" : "DRY-RUN"}] ${pathForLog} — re-encrypted`);
        if (APPLY) {
          await client.query(
            `UPDATE "${table_name}" SET "${column_name}" = $1 WHERE id = $2`,
            [newVal, row.id]
          );
        }
      }
    }

    if (APPLY) {
      if (stats.undecryptableAnomalies.length > 0) {
        console.error("\nAborting — undecryptable anomalies found (see below). Rolling back, nothing written.");
        await client.query("ROLLBACK");
      } else {
        await client.query("COMMIT");
        console.log("\nCOMMITTED.");
      }
    }
  } catch (e) {
    if (APPLY) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    throw e;
  } finally {
    await client.end();
  }

  console.log("\n=== Summary ===");
  console.log("Columns scanned:      ", stats.columnsScanned);
  console.log("Rows changed:         ", stats.rowsChanged);
  console.log("Leaves migrated:      ", stats.leavesMigrated);
  console.log("Already-migrated leaves (skipped):", stats.alreadyMigrated);
  console.log("Undecryptable anomalies:", stats.undecryptableAnomalies.length);
  if (stats.undecryptableAnomalies.length > 0) {
    console.log(stats.undecryptableAnomalies);
  }
  console.log(APPLY ? "\nMode: APPLY" : "\nMode: DRY-RUN (nothing written — pass --apply to write)");
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
