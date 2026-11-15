import { NextResponse } from "next/server";
import { signInOptions } from "@/lib/auth";

/**
 * GET /api/sso-providers
 * Returns how this deployment signs people in so the login pages can render the right thing: which providers are configured,
 * whether the password form is offered at all (not when Keycloak is the only sign-in), and which social sign-ins Keycloak
 * brokers. Safe to be public — no secrets.
 */
export async function GET() {
  return NextResponse.json(signInOptions());
}
