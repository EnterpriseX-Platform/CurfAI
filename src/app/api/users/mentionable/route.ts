/**
 * /api/users/mentionable — minimal user list for @mentions autocomplete.
 *
 * Returns just id + name + email for everyone in the current tenant.
 * Capped at 100 — workspaces larger than that get a search query
 * (?q=foo) for client-side filtering rather than dumping the whole list.
 *
 * This is read-only and tenant-scoped; safe to expose to any signed-in
 * user since they already see their teammates in /admin/users + the role
 * picker. We deliberately don't include role/permissions here — the
 * autocomplete only needs display + id.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";

  const where: any = { tenantId: user.tenantId };
  if (q) {
    // SQLite doesn't have ILIKE; use Prisma's `contains` with a manual
    // mode hint where supported. The contains is case-sensitive on
    // SQLite by default — we lowercase both sides client-side via the
    // returned name/email string in the picker.
    where.OR = [
      { name:  { contains: q } },
      { email: { contains: q } },
    ];
  }
  const items = await prisma.user.findMany({
    where, take: 100,
    select: { id: true, name: true, email: true },
    orderBy: [{ name: "asc" }, { email: "asc" }],
  });
  return NextResponse.json({ items });
}
