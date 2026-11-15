import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { ensureLimit } from "@/lib/rateLimit";
import type { FiredItem } from "@/lib/cron/types";
import { runPlatformTicks, runScheduleLoop } from "@/lib/cron/tickRunner";
import { jobsEnabled } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest)  { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }

/** Constant-time secret compare (SHA-256 equalises length so timingSafeEqual
 *  never throws on a mismatched-length guess and leaks no length via timing). */
function secretMatches(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

async function handle(req: NextRequest) {
  const url = new URL(req.url);
  // Header only — a `?secret=` query param would leak into access/proxy logs
  // and Referer headers.
  const secret = req.headers.get("x-cron-secret") ?? "";
  const expected = process.env.CRON_SECRET ?? "";
  if (!secretMatches(secret, expected)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const limited = await ensureLimit("cron", "global", 4, 60_000);
  if (limited) return limited;
  const force = url.searchParams.get("force") === "1";
  const now = new Date();

  // With a queue configured the workers own the schedule (lib/jobs); a tick request would only do the same work twice.
  // `?force=1` still runs it here, as the operator's manual trigger.
  if (jobsEnabled() && !force) {
    return NextResponse.json({ ok: true, fired: 0, mode: "queue", note: "Scheduled work runs in the job workers; use ?force=1 to run a tick here." });
  }

  const fired: FiredItem[] = [];
  if (!(await runScheduleLoop(req, now, force, fired))) {
    return NextResponse.json({ ok: true, fired: 0, note: "Schedule table not initialised" });
  }
  // Community ticks first, in the order they always ran; then the paid
  // edition's, through the registry. Same fired-array mutation, same
  // per-block error isolation.
  const extra = await runPlatformTicks(req, now, force, fired);

  return NextResponse.json({ ok: true, fired: fired.length, items: fired, ...extra });
}

