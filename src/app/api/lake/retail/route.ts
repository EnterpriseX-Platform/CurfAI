/**
 * The retail pack — reports and watchers on a workspace's own sales and
 * stock (lib/templates/retail).
 *
 *   GET  → { hasSales, hasStock, reports: [{ id, name }] } — what the
 *          Tables page's card shows: set up, or open the reports.
 *   POST { action: "setup" }   → work the figures out, then create whatever
 *          part of the pack the data supports and isn't there yet.
 *   POST { action: "refresh" } → work the figures out again (an import
 *          already does this; this is for "the numbers look stale").
 *
 * Admin or developer: setup creates billed reports and watchers.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { blockScopedApiKey, requireAdminOrEditor, requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { LOCALES, type Locale } from "@/lib/i18n/dict";
import { tenantLakeEngine } from "@/lib/lake/tenantEngine";
import { refreshRetailMetrics } from "@/lib/lake/retailMetrics";
import { keepRetailReportsCurrent, retailStatus, setupRetailPack } from "@/lib/templates/retail/setup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ action: z.enum(["setup", "refresh"]) });

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scoped = blockScopedApiKey(user);
  if (scoped) return scoped;
  return NextResponse.json(await retailStatus(user));
}

export async function POST(req: NextRequest) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  // The standard sales and stock tables live in the SQLite lake only.
  if ((await tenantLakeEngine(user.tenantId)) === "duckdb") {
    return NextResponse.json({ error: "Retail reports need the standard sales and stock tables, which aren't available on the DuckDB lake engine." }, { status: 409 });
  }

  if (parsed.data.action === "refresh") {
    const metrics = await refreshRetailMetrics(user, req);
    await keepRetailReportsCurrent(user);
    recordAudit({ user, kind: "retail.refresh", target: user.tenantId, req, meta: { tables: metrics.tables } });
    return NextResponse.json({ metrics, status: await retailStatus(user) });
  }

  const cookieLocale = req.cookies.get("rd_locale")?.value ?? "";
  const locale: Locale = (LOCALES as readonly string[]).includes(cookieLocale) ? (cookieLocale as Locale) : "en";
  const before = await retailStatus(user);
  if (!before.hasSales && !before.hasStock) {
    return NextResponse.json({ error: "Import a sales or stock file into the standard tables first." }, { status: 409 });
  }
  const result = await setupRetailPack(user, { locale, req });
  recordAudit({
    user,
    kind: "retail.setup",
    target: user.tenantId,
    req,
    meta: {
      locale,
      hasSales: result.status.hasSales,
      hasStock: result.status.hasStock,
      reportsCreated: result.summary.reportsCreated,
      watchersCreated: result.summary.watchersCreated,
      errorCount: result.summary.errors.length,
    },
  });
  return NextResponse.json(result);
}
