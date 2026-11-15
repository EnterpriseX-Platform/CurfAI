/**
 * Outbound-webhook signing secrets, encrypted at rest.
 *
 * A webhook's signing secret is used to HMAC every delivery, so it can't be hashed — it has to be read back. It used to
 * sit in the database as plain hex, while the compliance page said stored secrets are encrypted. Now it is encrypted with
 * the same AES-256-GCM helper as every other stored credential (lib/secrets.ts).
 *
 * Two kinds of value live in the column during the changeover, told apart by shape: a legacy secret is 64 hex characters;
 * an encrypted one is three base64url parts joined by ":". Reading handles both, writing always encrypts, and a sweep
 * (encryptLegacyWebhookSecrets, run from the cron tick) re-saves the old ones encrypted — so no one has to rotate.
 */
import { prisma } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/secrets";

const ENCRYPTED = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

export function isEncryptedSecret(stored: string): boolean {
  return ENCRYPTED.test(stored);
}

/** What to put in the column for this secret. */
export function storeWebhookSecret(plain: string): string {
  return encryptSecret(plain);
}

/** The secret to sign with, or null when it can't be read (an encrypted value under a different CURF_SECRET_KEY). */
export function readWebhookSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  return isEncryptedSecret(stored) ? decryptSecret(stored) : stored;
}

/** First eight characters, enough to tell two secrets apart after a rotation without showing the key. */
export function webhookSecretPreview(stored: string | null | undefined): string | null {
  const plain = readWebhookSecret(stored);
  return plain ? plain.slice(0, 8) + "…" : null;
}

/**
 * Encrypt any secret still stored in plain. Safe to run any number of times; a few hundred rows per call.
 * Cross-workspace by design (cron, no bound workspace).
 */
export async function encryptLegacyWebhookSecrets(): Promise<{ encrypted: number }> {
  // nosemgrep: prisma-must-include-tenant -- a maintenance sweep over every workspace's webhooks, run from the cron tick (no bound workspace)
  const rows = await prisma.webhook.findMany({
    where: { NOT: { signingSecret: { contains: ":" } } },
    select: { id: true, tenantId: true, signingSecret: true },
    take: 200,
  });
  let encrypted = 0;
  for (const r of rows) {
    if (!r.signingSecret || isEncryptedSecret(r.signingSecret)) continue;
    await prisma.webhook.update({ where: { id: r.id, tenantId: r.tenantId }, data: { signingSecret: storeWebhookSecret(r.signingSecret) } });
    encrypted++;
  }
  return { encrypted };
}
