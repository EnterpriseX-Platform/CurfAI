import { NextResponse } from "next/server";
import { engineJwks } from "@/lib/engine/identity";

// The public half of the key Curf signs engine tokens with (lib/engine/identity.ts). The engine fetches it
// to check every token; it is public by design and holds nothing that can sign. Not behind a session: the
// engine is a server and has none.
export const dynamic = "force-dynamic";

export async function GET() {
  let jwks: ReturnType<typeof engineJwks> = null;
  try {
    jwks = engineJwks();
  } catch {
    jwks = null; // a malformed key reads as "not set up", never as an error body that could leak details
  }
  if (!jwks) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(jwks, { headers: { "Cache-Control": "public, max-age=300" } });
}
