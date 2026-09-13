/**
 * /admin/snippets — workspace snippet library.
 *
 * Server Component shell pulls the list once + hands off to the client
 * SnippetsManager. Any tenant member can manage; the API enforces tenant
 * scoping. Snippets are surfaced in the Designer's "Insert snippet"
 * picker via the same /api/snippets endpoint.
 */
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { SnippetsManager } from "./SnippetsManager";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

export default async function SnippetsPage() {
  const session = await getSession();
  const sessionUser = (session?.user as any) ?? null;
  if (!sessionUser?.id) redirect("/login?callbackUrl=/admin/snippets");

  const items = await prisma.snippet.findMany({
    where: { tenantId: sessionUser.tenantId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, kind: true, body: true, description: true, tagsJson: true, updatedAt: true },
  });
  const initial = items.map((s: any) => ({
    ...s,
    tags: safeParseTags(s.tagsJson),
    updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : s.updatedAt,
  }));

  return (
    <div className="mx-auto max-w-5xl px-8 pb-12 pt-7">
      <PageHeader title={<>Saved snippets</>} description={<>Reusable SQL and REST fragments. Available in the Designer via the query editor's "Insert snippet" picker.</>} />

      <SnippetsManager initial={initial} />
    </div>
  );
}

function safeParseTags(json: string): string[] {
  try { return JSON.parse(json) ?? []; } catch { return []; }
}
