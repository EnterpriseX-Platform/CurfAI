/**
 * GET /api/dashboards/check?ids=a,b,c — how the report check judged each report a dashboard shows (lib/dashboards/check.ts
 * does the judging in the manager). Read-only, editors and admins, scoped to the caller's workspace: an id from another
 * workspace is simply absent, the same as a deleted one.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminOrEditor, reportWhere } from "@/lib/auth";
import type { ReportHealth } from "@/lib/dashboards/check";

const MAX_IDS = 12;

export async function GET(req: NextRequest) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  const ids = [...new Set((req.nextUrl.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (ids.length === 0) return NextResponse.json({ reports: {} });
  const rows = await prisma.report.findMany({ where: { ...reportWhere(user), id: { in: ids } }, select: { id: true, name: true, definition: true } });
  const reports: Record<string, ReportHealth> = {};
  for (const r of rows) {
    let quality: { verdict?: string; flags?: unknown[] } | undefined;
    try { quality = JSON.parse(r.definition)?.quality; } catch { /* an unreadable definition has no verdict */ }
    reports[r.id] = { name: r.name, verdict: quality?.verdict ?? null, flags: Array.isArray(quality?.flags) ? quality!.flags!.length : 0 };
  }
  return NextResponse.json({ reports });
}
