/**
 * /api/snippets — list + create.
 *
 * A snippet is a reusable SQL fragment, REST path, or POST body the author
 * can insert into a report query without re-typing. Tenant-scoped, with
 * (kind, name) unique. Listing supports a ?kind= filter so the Designer's
 * "Insert snippet" picker only shows the right kind for the field it's
 * augmenting (sql for query.sql, rest_path for query.path, etc).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

const SNIPPET_KINDS = ["sql", "rest_path", "rest_body"] as const;
const CreateSchema = z.object({
  name:        z.string().min(1).max(120),
  kind:        z.enum(SNIPPET_KINDS),
  body:        z.string().min(1),
  description: z.string().max(500).optional(),
  tags:        z.array(z.string()).max(10).optional(),
});

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const where: any = { tenantId: user.tenantId };
  if (kind && SNIPPET_KINDS.includes(kind as any)) where.kind = kind;
  const items = await prisma.snippet.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, kind: true, description: true, tagsJson: true, body: true, updatedAt: true },
  });
  return NextResponse.json({ items: items.map((s: any) => ({ ...s, tags: safeParseTags(s.tagsJson) })) });
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid snippet", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const created = await prisma.snippet.create({
      data: {
        tenantId: user.tenantId,
        name: parsed.data.name,
        kind: parsed.data.kind,
        body: parsed.data.body,
        description: parsed.data.description,
        tagsJson: JSON.stringify(parsed.data.tags ?? []),
        createdById: user.id,
      },
      select: { id: true, name: true, kind: true },
    });
    recordAudit({ user, kind: "snippet.create", target: created.id, req, meta: { name: created.name, kind: created.kind } });
    return NextResponse.json({ ok: true, snippet: created });
  } catch (e: any) {
    // Most likely a unique-constraint violation on (tenantId, kind, name).
    return NextResponse.json({ error: e?.code === "P2002" ? "A snippet with that name + kind already exists." : "Save failed" }, { status: 400 });
  }
}

function safeParseTags(json: string): string[] {
  try { return JSON.parse(json) ?? []; } catch { return []; }
}
