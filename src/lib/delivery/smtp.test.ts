/**
 * SMTP resolution — tenant settings (Admin → Tenant) must win over env,
 * env must keep working as the fallback, and the stored password must
 * round-trip through encryption without ever being stored in cleartext.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseStoredSmtpConfig,
  encodeSmtpConfig,
  settingsFromStored,
  smtpFromEnv,
} from "./smtp";

const ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  // Secrets helpers need a key; tests must not depend on the dev .env.
  if (!process.env.CURF_SECRET_KEY && !process.env.NEXTAUTH_SECRET) {
    process.env.NEXTAUTH_SECRET = "test-secret-for-smtp-tests";
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("encodeSmtpConfig / parseStoredSmtpConfig", () => {
  it("round-trips settings and never stores the cleartext password", () => {
    const json = encodeSmtpConfig({
      host: "smtp.example.com", port: 587, secure: false,
      user: "alerts@example.com", password: "hunter2-app-pass", from: "Curf <r@example.com>",
    });
    expect(json).not.toContain("hunter2-app-pass");
    const stored = parseStoredSmtpConfig(json)!;
    expect(stored.host).toBe("smtp.example.com");
    expect(stored.passwordEnc).toBeTruthy();
    const settings = settingsFromStored(stored);
    expect(settings.pass).toBe("hunter2-app-pass");
    expect(settings.source).toBe("tenant");
  });

  it("a blank password on re-save keeps the existing encrypted one", () => {
    const first = parseStoredSmtpConfig(encodeSmtpConfig({
      host: "smtp.example.com", port: 587, secure: false, password: "original",
    }))!;
    const second = parseStoredSmtpConfig(encodeSmtpConfig(
      { host: "smtp2.example.com", port: 465, secure: true },
      first,
    ))!;
    expect(second.host).toBe("smtp2.example.com");
    expect(settingsFromStored(second).pass).toBe("original");
  });

  it("tolerates garbage json and missing host", () => {
    expect(parseStoredSmtpConfig(null)).toBeNull();
    expect(parseStoredSmtpConfig("{nope")).toBeNull();
    expect(parseStoredSmtpConfig(JSON.stringify({ port: 587 }))).toBeNull();
  });

  it("clamps a nonsense port to 587", () => {
    const stored = parseStoredSmtpConfig(JSON.stringify({ host: "h", port: "banana" }))!;
    expect(stored.port).toBe(587);
  });
});

describe("smtpFromEnv fallback", () => {
  it("returns null when SMTP_HOST is unset (delivery reports skipped, not crash)", () => {
    expect(smtpFromEnv()).toBeNull();
  });

  it("reads the env transport when set, marking the source", () => {
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = "1025";
    process.env.SMTP_FROM = "Bot <bot@local>";
    const s = smtpFromEnv()!;
    expect(s.host).toBe("127.0.0.1");
    expect(s.port).toBe(1025);
    expect(s.secure).toBe(false);
    expect(s.from).toBe("Bot <bot@local>");
    expect(s.source).toBe("env");
  });

  it("treats port 465 as implicit TLS", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "465";
    expect(smtpFromEnv()!.secure).toBe(true);
  });
});
