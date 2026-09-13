/**
 * GET /api/push/vapid-public-key
 *
 * Returns the server's VAPID public key so the browser can register a
 * push subscription against it. Anonymous-readable — the public key is
 * meant to be public.
 *
 * The keypair is generated once (offline) and stored in env vars:
 *   CURF_VAPID_PUBLIC_KEY  — base64url, ~88 chars
 *   CURF_VAPID_PRIVATE_KEY — base64url, ~43 chars
 *
 * Generate with: `npx web-push generate-vapid-keys`. Set both halves
 * in .env. When the public key is missing we return 503 so the
 * subscribe UI knows to hide the "Enable notifications" button.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const key = process.env.CURF_VAPID_PUBLIC_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "Push notifications not configured. Server admin: set CURF_VAPID_PUBLIC_KEY + CURF_VAPID_PRIVATE_KEY." },
      { status: 503 },
    );
  }
  return NextResponse.json({ publicKey: key });
}
