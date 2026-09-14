/**
 * SuggestedTemplates — server-rendered section that appears on the
 * empty /reports page. Pulls top-N popular marketplace templates and
 * (when the user has any connections) bubbles up the ones whose
 * required connector kinds intersect what they actually own.
 *
 * Falls back to "globally popular" when no connection match exists,
 * so first-session users still see something useful even before they
 * wire up any data.
 *
 * No-op when the marketplace table doesn't exist yet (pre-db-push).
 */
import Link from "next/link";
import { Layers, Download, ChevronRight } from "lucide-react";
import { prisma } from "@/lib/db";
import { extractWiringRequirements } from "@/lib/reporting/sanitizeTemplate";

type Suggestion = {
  slug: string;
  name: string;
  description: string;
  category: string;
  authorName: string;
  thumbnailUrl: string | null;
  downloads: number;
  matchScore: number; // 0..1, how many of its placeholders match the user's kinds
};

export async function SuggestedTemplates({ tenantId }: { tenantId: string }) {
  let myKinds: Set<string> = new Set();
  try {
    const conns = await prisma.dataSource.findMany({
      where: { tenantId },
      select: { kind: true },
    });
    myKinds = new Set(conns.map((c) => c.kind));
  } catch { /* tolerate absence */ }

  let candidates: any[] = [];
  try {
    candidates = await prisma.marketplaceTemplate.findMany({
      where: { status: "published" },
      orderBy: { downloads: "desc" },
      take: 12,
      select: {
        slug: true, name: true, description: true, category: true,
        authorName: true, thumbnailUrl: true, downloads: true, definitionJson: true,
      },
    });
  } catch { return null; }
  if (candidates.length === 0) return null;

  const scored: Suggestion[] = [];
  for (const t of candidates) {
    let kinds: string[] = [];
    try {
      const def = JSON.parse(t.definitionJson);
      kinds = extractWiringRequirements(def).map((w) => w.kind);
    } catch { /* skip */ }
    let matched = 0;
    for (const k of kinds) if (myKinds.has(k)) matched++;
    const matchScore = kinds.length === 0 ? 0 : matched / kinds.length;
    scored.push({
      slug: t.slug,
      name: t.name,
      description: t.description ?? "",
      category: t.category,
      authorName: t.authorName,
      thumbnailUrl: t.thumbnailUrl,
      downloads: t.downloads,
      matchScore,
    });
  }

  // Pick top 3: prefer matched, then by downloads. When the user has
  // zero connections (myKinds empty), this collapses to "top by downloads"
  // which is the right outcome for a brand-new workspace.
  scored.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    return b.downloads - a.downloads;
  });
  const top = scored.slice(0, 3);
  if (top.length === 0) return null;

  const showMatchHint = myKinds.size > 0 && top.some((s) => s.matchScore > 0);

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-end justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {showMatchHint ? "Suggested for your connections" : "Popular on the marketplace"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {showMatchHint
              ? "Templates other workspaces published that fit the data you already have wired."
              : "Templates other workspaces published. One click to clone into your workspace."}
          </p>
        </div>
        <Link href="/marketplace" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          Browse all <ChevronRight className="h-3 w-3" />
        </Link>
      </div>

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {top.map((t) => (
          <li key={t.slug}>
            <Link
              href={"/marketplace/" + t.slug}
              className="group block h-full overflow-hidden rounded-lg border border-border bg-card transition hover:border-primary/40 hover:shadow-md"
            >
              {t.thumbnailUrl ? (
                <div className="aspect-[16/9] w-full overflow-hidden bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={t.thumbnailUrl} alt="" className="h-full w-full object-cover transition group-hover:scale-105" />
                </div>
              ) : (
                <div className="grid aspect-[16/9] place-items-center bg-muted">
                  <Layers className="h-8 w-8 text-muted-foreground/60" />
                </div>
              )}
              <div className="p-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t.category}
                  </span>
                  {t.matchScore > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success ">
                      Wires to your data
                    </span>
                  )}
                  <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Download className="h-3 w-3" /> {t.downloads.toLocaleString()}
                  </span>
                </div>
                <h3 className="text-sm font-semibold leading-snug">{t.name}</h3>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {t.description || "No description provided."}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
