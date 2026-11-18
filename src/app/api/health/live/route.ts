import { NextResponse } from "next/server";
import { appVersion, uptimeS } from "@/lib/health";

/** Liveness: the process answers HTTP. Touches nothing else, so a database or Redis outage never gets the pod restarted. */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ status: "ok", uptimeS: uptimeS(), version: appVersion() });
}
