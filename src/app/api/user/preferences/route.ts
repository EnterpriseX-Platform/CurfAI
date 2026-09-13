/**
 * /api/user/preferences — per-user theme override + density + a11y prefs.
 *
 * GET returns the current user's preferences (parsed from the JSON column).
 * PUT merges a partial update — explicit `null` for themeOverride clears the
 * override (so the report theme + tenant default win again).
 *
 * No tier gate. Personalization is free for everyone — that's the point.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { ThemeSchema } from "@/lib/reporting/schema";

const PrefsSchema = z.object({
  themeOverride: ThemeSchema.nullable().optional(),
  mode:          z.enum(["light", "dark", "auto"]).optional(),
  density:       z.enum(["comfortable", "compact"]).optional(),
  fontScale:     z.number().min(0.875).max(1.25).optional(),
  reducedMotion: z.boolean().optional(),
  // Viewer-local forecast override (per user, applies across every report
  // they view) — lets a reader without edit access turn a forecast overlay
  // on/off and pick method/horizon for themselves, without touching the
  // report's own saved definition. See ChartBlock.tsx's ForecastControl.
  forecastViewerPrefs: z.object({
    enabled: z.boolean(),
    method:  z.enum(["linear", "ets", "llm"]),
    periods: z.number().int().min(1).max(24),
  }).nullable().optional(),
});

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { preferencesJson: true } as any,
  });
  let prefs: Record<string, unknown> = {};
  try { prefs = row ? JSON.parse((row as any).preferencesJson || "{}") : {}; } catch {}
  return NextResponse.json({ preferences: prefs });
}

export async function PUT(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const parsed = PrefsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid preferences", issues: parsed.error.issues }, { status: 400 });
  }
  // Merge with existing — partial update, explicit null clears.
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { preferencesJson: true } as any,
  });
  let current: Record<string, unknown> = {};
  try { current = row ? JSON.parse((row as any).preferencesJson || "{}") : {}; } catch {}
  const next = { ...current, ...parsed.data };
  // Strip explicit-null keys so the JSON stays tidy.
  for (const k of Object.keys(next)) {
    if ((next as any)[k] === null) delete (next as any)[k];
  }
  await (prisma.user as any).update({
    where: { id: user.id },
    data: { preferencesJson: JSON.stringify(next) },
  });

  recordAudit({
    user, kind: "user.preferences.update", target: user.id, req,
    meta: { fields: Object.keys(parsed.data) },
  });

  return NextResponse.json({ ok: true, preferences: next });
}
