/**
 * SMTP transport resolution — tenant settings first, env fallback.
 *
 * Production deploys configure SMTP from Admin → Tenant (stored on
 * Tenant.smtpConfigJson with the password AES-256-GCM encrypted) instead of
 * hardcoding SMTP_* env vars. The env vars keep working as a
 * platform-level fallback so existing single-tenant installs don't break.
 */
import { prisma } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/secrets";

export type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  /** Where the settings came from — surfaced in test-send results. */
  source: "tenant" | "env";
};

export type StoredSmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  passwordEnc?: string;
  from?: string;
};

/** Parse + validate Tenant.smtpConfigJson. Returns null when absent/garbled. */
export function parseStoredSmtpConfig(json: string | null | undefined): StoredSmtpConfig | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    if (!p || typeof p.host !== "string" || !p.host.trim()) return null;
    const port = Number(p.port);
    return {
      host: p.host.trim(),
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 587,
      secure: p.secure === true,
      user: typeof p.user === "string" && p.user ? p.user : undefined,
      passwordEnc: typeof p.passwordEnc === "string" && p.passwordEnc ? p.passwordEnc : undefined,
      from: typeof p.from === "string" && p.from ? p.from : undefined,
    };
  } catch {
    return null;
  }
}

/** Serialise settings for storage, encrypting the password. `existing` keeps the old password when the form leaves it blank. */
export function encodeSmtpConfig(
  input: { host: string; port: number; secure: boolean; user?: string; password?: string; from?: string },
  existing?: StoredSmtpConfig | null,
): string {
  const passwordEnc = input.password
    ? encryptSecret(input.password)
    : existing?.passwordEnc;
  return JSON.stringify({
    host: input.host.trim(),
    port: input.port,
    secure: input.secure,
    user: input.user?.trim() || undefined,
    passwordEnc,
    from: input.from?.trim() || undefined,
  });
}

/** Env-var fallback (the pre-existing behavior). */
export function smtpFromEnv(): SmtpSettings | null {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    user: process.env.SMTP_USER || undefined,
    pass: process.env.SMTP_PASS || undefined,
    from: process.env.SMTP_FROM ?? "curf@localhost",
    source: "env",
  };
}

/** Decrypt a stored tenant config into ready-to-use settings. */
export function settingsFromStored(cfg: StoredSmtpConfig): SmtpSettings {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user,
    pass: cfg.passwordEnc ? decryptSecret(cfg.passwordEnc) ?? undefined : undefined,
    from: cfg.from ?? "curf@localhost",
    source: "tenant",
  };
}

/**
 * Resolve the transport for a tenant: tenant-configured SMTP wins, env is
 * the fallback, null means email delivery is unconfigured (callers report
 * "skipped", never throw).
 */
export async function resolveSmtp(tenantId?: string | null): Promise<SmtpSettings | null> {
  if (tenantId) {
    try {
      const t = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { smtpConfigJson: true },
      });
      const stored = parseStoredSmtpConfig(t?.smtpConfigJson);
      if (stored) return settingsFromStored(stored);
    } catch {
      // Column may not exist until `prisma db push` runs — fall through to env.
    }
  }
  return smtpFromEnv();
}
