import { NextResponse } from "next/server";
import { checkReady } from "@/lib/health";

/** Readiness: can this pod do useful work now (database reachable). 503 takes it out of the Service until it can. */
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await checkReady();
  return NextResponse.json(r.body, { status: r.ok ? 200 : 503 });
}
