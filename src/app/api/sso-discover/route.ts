import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ee } from "@/ee";
import { ensureLimit } from "@/lib/rateLimit";
import { clientIp } from "@/lib/security/clientIp";

export const dynamic = "force-dynamic";

/**
 * POST /api/sso-discover { email } — identity-first sign-in. Answers { alias } when the email's domain belongs to an organisation
 * that has switched on a company sign-in (the login page then starts Keycloak with that alias as `kc_idp_hint`), else { alias: null }.
 *
 * Public by nature (it runs before anyone is signed in), so it is rate limited per address and per source, and it says as little as
 * it can: the alias is a random name, never the company, its provider or its protocol. Whether a domain uses company sign-in is
 * not a secret: its own login page says so.
 */
const Schema = z.object({ email: z.string().email().max(254) });

export async function POST(req: NextRequest) {
  const limited = await ensureLimit("sso-discover", `ip:${clientIp(req)}`, 30, 5 * 60_000);
  if (limited) return limited;
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  const found = (await ee.identity?.companySignIn(parsed.data.email).catch(() => null)) ?? null;
  return NextResponse.json({ alias: found?.alias ?? null });
}
