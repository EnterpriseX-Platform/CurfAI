import { NextResponse } from "next/server";
import { enabledSsoProviders } from "@/lib/auth";

/**
 * GET /api/sso-providers
 * Returns which OIDC providers are configured in this deployment so the
 * login page can render corresponding buttons. Safe to be public — no secrets.
 */
export async function GET() {
  return NextResponse.json({ providers: enabledSsoProviders() });
}
