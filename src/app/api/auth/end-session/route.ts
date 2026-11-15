/**
 * GET /api/auth/end-session — where the browser goes right after NextAuth's sign-out. With Keycloak as the sign-in it
 * redirects to Keycloak's end-session endpoint so the person is signed out of their single sign-on session there too
 * (otherwise "Continue with single sign-on" would sign them straight back in); otherwise it goes home. No session needed:
 * by now the cookie is gone, and the redirect target is built from configuration, never from the request.
 */
import { NextRequest, NextResponse } from "next/server";
import { ee } from "@/ee";
import { appBase } from "@/lib/http/appBase";
import { sameSitePath } from "@/lib/http/safePath";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const base = appBase(req);
  // Where the person lands afterwards: a path on this site only (?to=/executive/login), the login page when Keycloak ends the session.
  const to = sameSitePath(req.nextUrl.searchParams.get("to"), "/");
  const url = ee.identity?.endSessionUrl(`${base}${to === "/" ? "/login" : to}`);
  return NextResponse.redirect(url ?? `${base}${to}`, 302);
}
