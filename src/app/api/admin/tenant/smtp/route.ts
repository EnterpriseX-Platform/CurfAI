/**
 * /api/admin/tenant/smtp — per-tenant SMTP transport settings.
 *
 *   GET    — read masked status (host, port, user, masked password, from)
 *   PUT    — set / update; empty password keeps the existing one
 *   POST   — send a test email using the SAVED settings
 *   DELETE — remove (email delivery falls back to SMTP_* env or is skipped)
 *
 * Admin-only. The password is AES-256-GCM encrypted at rest and never
 * echoed back — the UI gets a "configured" flag only. Mirrors the tenant
 * LLM-key route's shape so production deploys configure email from the
 * Settings page instead of hardcoding SMTP_* env vars.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import {
  parseStoredSmtpConfig,
  encodeSmtpConfig,
  settingsFromStored,
  smtpFromEnv,
} from "@/lib/delivery/smtp";

const PutSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  user: z.string().max(255).optional().nullable(),
  /** Empty string keeps the previously saved password. */
  password: z.string().max(500).optional().nullable(),
  from: z.string().max(255).optional().nullable(),
});

const TestSchema = z.object({
  to: z.string().email().max(255),
});

export async function GET(req: NextRequest) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  let stored: ReturnType<typeof parseStoredSmtpConfig> = null;
  try {
    const t = await prisma.tenant.findUnique({
      where: { id: u.tenantId },
      select: { smtpConfigJson: true },
    });
    stored = parseStoredSmtpConfig(t?.smtpConfigJson);
  } catch { /* column missing until prisma db push */ }

  return NextResponse.json({
    configured: !!stored,
    host: stored?.host ?? null,
    port: stored?.port ?? null,
    secure: stored?.secure ?? false,
    user: stored?.user ?? null,
    hasPassword: !!stored?.passwordEnc,
    from: stored?.from ?? null,
    // Whether the platform env provides a fallback when tenant SMTP is unset.
    fallbackEnv: !!smtpFromEnv(),
  });
}

export async function PUT(req: NextRequest) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const body = await req.json().catch(() => null);
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid settings", issues: parsed.error.issues }, { status: 400 });
  }

  const t = await prisma.tenant.findUnique({
    where: { id: u.tenantId },
    select: { smtpConfigJson: true },
  });
  const existing = parseStoredSmtpConfig(t?.smtpConfigJson);

  const json = encodeSmtpConfig(
    {
      host: parsed.data.host,
      port: parsed.data.port,
      secure: parsed.data.secure,
      user: parsed.data.user ?? undefined,
      password: parsed.data.password || undefined,
      from: parsed.data.from ?? undefined,
    },
    existing,
  );
  await prisma.tenant.update({
    where: { id: u.tenantId },
    data: { smtpConfigJson: json },
  });

  recordAudit({
    user: u, kind: "tenant.smtp.set", target: u.tenantId,
    // Never the password — host/port only, enough to trace a misconfig.
    meta: { host: parsed.data.host, port: parsed.data.port },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  await prisma.tenant.update({
    where: { id: u.tenantId },
    data: { smtpConfigJson: null },
  });
  recordAudit({ user: u, kind: "tenant.smtp.removed", target: u.tenantId, meta: {} });
  return NextResponse.json({ ok: true });
}

/** POST — send a test email through the SAVED tenant settings. */
export async function POST(req: NextRequest) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const body = await req.json().catch(() => null);
  const parsed = TestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Provide a valid \"to\" email address" }, { status: 400 });
  }

  const t = await prisma.tenant.findUnique({
    where: { id: u.tenantId },
    select: { smtpConfigJson: true, name: true },
  });
  const stored = parseStoredSmtpConfig(t?.smtpConfigJson);
  const smtp = stored ? settingsFromStored(stored) : smtpFromEnv();
  if (!smtp) {
    return NextResponse.json({ ok: false, error: "No SMTP settings saved yet — save the form first." }, { status: 400 });
  }

  let nodemailer: any;
  try {
    const dynImport: (s: string) => Promise<any> = new Function("s", "return import(s)") as any;
    const mod = await dynImport("nodemailer");
    nodemailer = mod.default ?? mod;
  } catch {
    return NextResponse.json({ ok: false, error: "nodemailer not installed on the server" }, { status: 500 });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
      // A test click should fail fast, not hang the admin page.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });
    const info = await transporter.sendMail({
      from: smtp.from,
      to: parsed.data.to,
      subject: `Curf SMTP test — ${t?.name ?? "workspace"}`,
      text: `This is a test email from Curf.\n\nTransport: ${smtp.source === "tenant" ? "workspace SMTP settings" : "SMTP_* environment variables"}\nHost: ${smtp.host}:${smtp.port}\nSent: ${new Date().toISOString()}`,
    });
    recordAudit({ user: u, kind: "tenant.smtp.test", target: u.tenantId, meta: { to: parsed.data.to, ok: true } });
    return NextResponse.json({ ok: true, messageId: info.messageId ?? null, source: smtp.source });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "SMTP send failed" }, { status: 502 });
  }
}
