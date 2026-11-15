/**
 * GET /api/me/data-export — a person's own data, as one JSON download (PDPA / GDPR access request).
 *
 * Session only (never an API key: a key is not the person), rate-limited, and logged as a data-subject request so the
 * operator console shows it was answered. What it holds: lib/lifecycle/person.ts exportPersonalData.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { persistAudit } from "@/lib/audit";
import { rateLimit } from "@/lib/rateLimit";
import { LifecycleError } from "@/lib/lifecycle/deletion";
import { closeRequest, exportPersonalData, openRequest } from "@/lib/lifecycle/person";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.viaApiKey) return NextResponse.json({ error: "Session required" }, { status: 403 });
  if (!(await rateLimit(`me-export:${user.id}`, 5, 3_600_000)).ok) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });

  const dsr = await openRequest({ kind: "export", subjectEmail: user.email, subjectUserId: user.id, channel: "self_service" });
  try {
    await persistAudit({ user, kind: "user.data_export", target: user.id, req });
    const data = await exportPersonalData(user.id);
    await closeRequest(dsr.id, "completed", user.email);
    return new NextResponse(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="curf-my-data.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    await closeRequest(dsr.id, "failed", user.email, String(e?.message ?? e).slice(0, 300)).catch(() => null);
    if (e instanceof LifecycleError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
