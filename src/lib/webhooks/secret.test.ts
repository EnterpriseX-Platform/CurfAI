/**
 * Webhook signing secrets: stored encrypted, still readable, and any legacy plaintext one is upgraded without anyone
 * rotating.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prisma = vi.hoisted(() => ({ webhook: { findMany: vi.fn(), update: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma }));

import {
  isEncryptedSecret, storeWebhookSecret, readWebhookSecret, webhookSecretPreview, encryptLegacyWebhookSecrets,
} from "./secret";
import { generateSigningSecret } from "./dispatcher";

const legacy = generateSigningSecret(); // 64 hex characters, as stored before encryption

beforeEach(() => { vi.clearAllMocks(); prisma.webhook.update.mockResolvedValue({}); });

describe("shape", () => {
  it("tells an encrypted value from a legacy plaintext one", () => {
    expect(legacy).toMatch(/^[0-9a-f]{64}$/);
    expect(isEncryptedSecret(legacy)).toBe(false);
    expect(isEncryptedSecret(storeWebhookSecret(legacy))).toBe(true);
  });
});

describe("store and read", () => {
  it("encrypts: the stored value is not the secret, and it reads back", () => {
    const stored = storeWebhookSecret(legacy);
    expect(stored).not.toContain(legacy);
    expect(readWebhookSecret(stored)).toBe(legacy);
  });

  it("a legacy plaintext secret still reads, so nothing breaks before the sweep gets to it", () => {
    expect(readWebhookSecret(legacy)).toBe(legacy);
  });

  it("two encryptions of the same secret differ (fresh IV each time)", () => {
    expect(storeWebhookSecret(legacy)).not.toBe(storeWebhookSecret(legacy));
  });

  it("a tampered or foreign ciphertext reads as null — never as a wrong secret", () => {
    const stored = storeWebhookSecret(legacy);
    const [iv, tag, ct] = stored.split(":");
    expect(readWebhookSecret(`${iv}:${tag}:${ct!.slice(0, -2)}AA`)).toBeNull();
    expect(readWebhookSecret("aaaa:bbbb:cccc")).toBeNull();
  });

  it("nothing stored reads as null", () => {
    expect(readWebhookSecret(null)).toBeNull();
    expect(readWebhookSecret("")).toBeNull();
  });
});

describe("preview", () => {
  it("is the first eight characters of the real secret, whether stored plain or encrypted", () => {
    expect(webhookSecretPreview(legacy)).toBe(legacy.slice(0, 8) + "…");
    expect(webhookSecretPreview(storeWebhookSecret(legacy))).toBe(legacy.slice(0, 8) + "…");
    expect(webhookSecretPreview(null)).toBeNull();
    expect(webhookSecretPreview("a:b:c")).toBeNull(); // unreadable: shows nothing rather than part of a ciphertext
  });
});

describe("encryptLegacyWebhookSecrets", () => {
  it("re-saves each plaintext secret encrypted, scoped to its own workspace, and reports the count", async () => {
    prisma.webhook.findMany.mockResolvedValueOnce([
      { id: "w1", tenantId: "t1", signingSecret: legacy },
      { id: "w2", tenantId: "t2", signingSecret: storeWebhookSecret(generateSigningSecret()) }, // already encrypted: left alone
      { id: "w3", tenantId: "t3", signingSecret: "" },
    ]);
    expect(await encryptLegacyWebhookSecrets()).toEqual({ encrypted: 1 });
    expect(prisma.webhook.update).toHaveBeenCalledTimes(1);
    const call = prisma.webhook.update.mock.calls[0]![0];
    expect(call.where).toEqual({ id: "w1", tenantId: "t1" });
    expect(readWebhookSecret(call.data.signingSecret)).toBe(legacy);
  });

  it("only ever looks at rows that are not yet encrypted", async () => {
    prisma.webhook.findMany.mockResolvedValueOnce([]);
    await encryptLegacyWebhookSecrets();
    expect(prisma.webhook.findMany.mock.calls[0]![0].where).toEqual({ NOT: { signingSecret: { contains: ":" } } });
  });
});
