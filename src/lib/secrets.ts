import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { prisma } from "@/lib/db";

/**
 * Symmetric encryption for tenant-level secrets (Anthropic key, etc).
 *
 * Algorithm: AES-256-GCM. The key is derived from CURF_SECRET_KEY (env)
 * via scrypt with a fixed salt - that gives us a 32-byte AES key from any
 * passphrase length. GCM gives us authenticated encryption: tampering with
 * the ciphertext fails the auth tag check on decrypt.
 *
 * Format on disk: base64url(iv) + ":" + base64url(tag) + ":" + base64url(ciphertext)
 *
 * Dev fallback: if CURF_SECRET_KEY is unset we derive a deterministic key
 * from a constant. Tenant secrets stored against that key won't decrypt
 * once you set a real CURF_SECRET_KEY - that's intentional. Don't put real
 * production secrets in dev without setting the env first.
 */

const SALT = "curf-secrets-v1";

function deriveKey(): Buffer {
  const passphrase = process.env.CURF_SECRET_KEY ?? "curf-dev-secret-please-override-in-prod";
  return scryptSync(passphrase, SALT, 32);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function encryptSecret(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(12); // 96-bit IV for GCM (NIST recommended)
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return b64url(iv) + ":" + b64url(tag) + ":" + b64url(ct);
}

export function decryptSecret(encoded: string): string | null {
  try {
    const [ivB, tagB, ctB] = encoded.split(":");
    if (!ivB || !tagB || !ctB) return null;
    const key = deriveKey();
    const decipher = createDecipheriv("aes-256-gcm", key, fromB64url(ivB));
    decipher.setAuthTag(fromB64url(tagB));
    const pt = Buffer.concat([decipher.update(fromB64url(ctB)), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve the Anthropic API key for a request.
 *
 * NOTE: This is the legacy single-provider helper. New code should use
 * `getLlmCredentials()` (lib/llm/credentials.ts) which returns the
 * tenant's chosen provider + key + model + base URL. Kept for back-compat
 * with code paths that haven't migrated yet.
 *
 *   1. Tenant llmKeyEnc when llmProvider is "anthropic" or unset.
 *   2. Tenant anthropicKeyEnc (legacy column) — prior to LLM pivot.
 *   3. Falls back to ANTHROPIC_API_KEY env (platform-wide key).
 *   4. Returns null when nothing is set.
 */
export async function getAnthropicKey(tenantId: string | null | undefined): Promise<string | null> {
  if (tenantId) {
    try {
      const t = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { llmKeyEnc: true, llmProvider: true, anthropicKeyEnc: true },
      });
      // New shape — only honour llmKeyEnc when provider is anthropic.
      if ((t?.llmProvider ?? "anthropic") === "anthropic" && t?.llmKeyEnc) {
        const decrypted = decryptSecret(t.llmKeyEnc);
        if (decrypted) return decrypted;
      }
      // Legacy back-compat fallthrough.
      if (t?.anthropicKeyEnc) {
        const decrypted = decryptSecret(t.anthropicKeyEnc);
        if (decrypted) return decrypted;
      }
    } catch {
      // Tolerate missing column pre-db-push — fall through to env.
    }
  }
  return process.env.ANTHROPIC_API_KEY ?? null;
}

/**
 * Mask a key for safe display in the UI: show prefix + last 4 chars only.
 *   sk-ant-api03-abc...xyz123  ->  sk-ant-api03-...x123
 */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "•••";
  const head = key.slice(0, 12);
  const tail = key.slice(-4);
  return head + "…" + tail;
}
