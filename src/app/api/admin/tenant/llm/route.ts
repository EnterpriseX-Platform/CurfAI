/**
 * /api/admin/tenant/llm — provider-agnostic LLM settings.
 *
 *   GET    — read masked status (provider, masked key preview, model, base URL)
 *   PUT    — set / update provider + key + model (+ fast model) + base URL
 *   DELETE — remove credentials (LLM features fall back to platform env / disabled)
 *
 * Admin-only. Stores the key encrypted at rest. Never returns the cleartext —
 * only a masked preview ("sk-…x123") so admins can confirm what's configured
 * without exposing the secret in the UI.
 *
 * Audit events on every set/remove so misuse is traceable. The plaintext is
 * never logged or echoed in audit metadata.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { encryptSecret, decryptSecret, maskKey } from "@/lib/secrets";
import { listDrivers } from "@/lib/llm";

const VALID_PROVIDERS = ["anthropic", "openai", "gemini", "openai-compatible"] as const;

const PutSchema = z.object({
  provider: z.enum(VALID_PROVIDERS),
  /** Pass an empty string to keep the existing key. */
  key: z.string().max(500).optional(),
  model: z.string().max(120).optional().nullable(),
  /** Optional second model for Q&A-shaped calls (see isFastKind in lib/llm). */
  fastModel: z.string().max(120).optional().nullable(),
  baseUrl: z.string().max(300).optional().nullable(),
});

export async function GET(req: NextRequest) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  let provider = "anthropic";
  let masked: string | null = null;
  let model: string | null = null;
  let fastModel: string | null = null;
  let baseUrl: string | null = null;
  let migrationNeeded = false;
  let legacyKeyPresent = false;
  try {
    const t = await prisma.tenant.findUnique({
      where: { id: u.tenantId },
      select: {
        llmProvider: true,
        llmKeyEnc: true,
        llmModel: true,
        llmFastModel: true,
        llmBaseUrl: true,
        anthropicKeyEnc: true,
      },
    });
    provider = t?.llmProvider ?? "anthropic";
    model = t?.llmModel ?? null;
    fastModel = t?.llmFastModel ?? null;
    baseUrl = t?.llmBaseUrl ?? null;
    if (t?.llmKeyEnc) {
      const decrypted = decryptSecret(t.llmKeyEnc);
      masked = decrypted ? maskKey(decrypted) : "•••• (decryption failed — re-enter)";
    } else if (t?.anthropicKeyEnc) {
      // Legacy column — surface so admin can migrate by saving once.
      legacyKeyPresent = true;
      const decrypted = decryptSecret(t.anthropicKeyEnc);
      masked = decrypted ? maskKey(decrypted) : null;
    }
  } catch {
    migrationNeeded = true;
  }

  return NextResponse.json({
    provider,
    configured: !!masked,
    masked,
    model,
    fastModel,
    baseUrl,
    migrationNeeded,
    legacyKeyPresent,
    fallbackEnv: !!(
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      (process.env.CURF_LLM_PROVIDER && process.env.CURF_LLM_KEY)
    ),
    drivers: listDrivers().map((d) => ({
      id: d.id,
      label: d.label,
      defaultModel: d.defaultModel,
      credentialHint: d.credentialHint,
      consoleUrl: d.consoleUrl ?? null,
      needsBaseUrl: !!d.needsBaseUrl,
      baseUrlSuggestions: d.baseUrlSuggestions ?? [],
    })),
  });
}

export async function PUT(req: NextRequest) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const body = await req.json().catch(() => null);
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  // Check if this is a "save without changing the key" scenario by looking
  // at the existing row.
  const existing = await prisma.tenant.findUnique({
    where: { id: u.tenantId },
    select: { llmKeyEnc: true, anthropicKeyEnc: true, llmProvider: true },
  });
  const newKey = parsed.data.key?.trim();

  let llmKeyEnc: string | null = existing?.llmKeyEnc ?? null;
  if (newKey && newKey.length >= 8) {
    llmKeyEnc = encryptSecret(newKey);
  } else if (!llmKeyEnc && existing?.anthropicKeyEnc && parsed.data.provider === "anthropic") {
    // Adopt legacy anthropic key on first save when no new key was provided.
    llmKeyEnc = existing.anthropicKeyEnc;
  } else if (!llmKeyEnc) {
    return NextResponse.json({ error: "An API key is required for this provider." }, { status: 400 });
  }

  await prisma.tenant.update({
    where: { id: u.tenantId },
    data: {
      llmProvider: parsed.data.provider,
      llmKeyEnc,
      llmModel: parsed.data.model || null,
      llmFastModel: parsed.data.fastModel || null,
      llmBaseUrl: parsed.data.baseUrl || null,
    },
  });

  recordAudit({
    user: u, kind: "tenant.llm.set", target: u.tenantId, req,
    meta: {
      provider: parsed.data.provider,
      model: parsed.data.model || null,
      fastModel: parsed.data.fastModel || null,
      baseUrlPresent: !!parsed.data.baseUrl,
      keyChanged: !!newKey,
    },
  });

  // Decrypt for masked echo.
  const masked = maskKey(decryptSecret(llmKeyEnc ?? "") ?? "");
  return NextResponse.json({
    provider: parsed.data.provider,
    configured: true,
    masked,
    model: parsed.data.model || null,
    fastModel: parsed.data.fastModel || null,
    baseUrl: parsed.data.baseUrl || null,
  });
}

export async function DELETE(req: NextRequest) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  await prisma.tenant.update({
    where: { id: u.tenantId },
    data: { llmKeyEnc: null, llmModel: null, llmFastModel: null, llmBaseUrl: null },
  });
  recordAudit({ user: u, kind: "tenant.llm.remove", target: u.tenantId, req });
  return NextResponse.json({ configured: false, masked: null });
}
