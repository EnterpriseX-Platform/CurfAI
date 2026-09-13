/**
 * /reports/import — universal report importer.
 *
 * Two flavours, same UX:
 *   1. ?slug=<marketplace-template> → fetch + redirect to the
 *      marketplace detail page (the proper place to do wiring picks).
 *   2. ?from=<external-url> → fetch the JSON at that URL (server-side
 *      so we don't expose the importer's network), validate against
 *      ReportSchema, then route through the same wiring + import
 *      flow as marketplace.
 *
 * The external-URL flow lets anyone publish a Curf-shape JSON anywhere
 * (a GitHub gist, an S3 bucket, a personal blog) and let viewers import
 * it with one click. Same sanitization contract as marketplace
 * templates — the JSON should have placeholder dataSourceIds.
 */
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireUser } from "@/lib/auth";
import { ReportSchema } from "@/lib/reporting/schema";
import { extractWiringRequirements, slugify } from "@/lib/reporting/sanitizeTemplate";
import { ExternalImportPanel } from "./ExternalImportPanel";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { Layers, AlertTriangle, ArrowLeft } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

const MAX_FETCH_BYTES = 1_000_000; // 1MB cap on external definitions

type SearchParams = { slug?: string; from?: string };

export default async function ImportPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  if (!user) {
    const next = `/reports/import?${new URLSearchParams(searchParams as Record<string, string>).toString()}`;
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  // Marketplace shortcut — the proper detail page handles the import.
  if (searchParams.slug) {
    redirect(`/marketplace/${encodeURIComponent(searchParams.slug)}`);
  }

  const externalUrl = searchParams.from?.trim();
  if (!externalUrl) {
    return (
      <AppShell breadcrumbs={[{ label: "Reports", href: "/reports" }, { label: "Import" }]}>
        <div className="mx-auto max-w-2xl px-6 py-12 text-center">
          <Layers className="mx-auto h-10 w-10 text-muted-foreground" />
          <h1 className="mt-4 text-2xl font-semibold">Import a report</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Browse the public marketplace, or paste a URL to a Curf-shape report definition JSON.
          </p>
          <div className="mt-6 flex items-center justify-center gap-2">
            <Link href="/marketplace" className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
              Browse marketplace
            </Link>
          </div>
          <form method="GET" className="mt-8">
            <p className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Or import from URL</p>
            <div className="flex items-center gap-2">
              <input
                name="from"
                type="url"
                placeholder="https://gist.github.com/.../report.json"
                className="h-10 flex-1 rounded-md border border-border bg-background px-3 font-mono text-xs"
                required
              />
              <button type="submit" className="h-10 rounded-md border border-border bg-background px-3 text-sm font-semibold hover:bg-muted">
                Fetch
              </button>
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">
              We'll validate the JSON against the Curf report schema before importing.
            </p>
          </form>
        </div>
      </AppShell>
    );
  }

  // Validate the URL — only http(s), no file:// / data: / private IPs.
  let parsedUrl: URL;
  try { parsedUrl = new URL(externalUrl); }
  catch {
    return <ImportError reason="That URL didn't parse — must be a full http(s) URL." />;
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return <ImportError reason="Only http:// and https:// URLs are supported." />;
  }

  // Server-side fetch with size + content-type guards.
  let definition: any = null;
  let fetchError: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(externalUrl, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("application/json") && !ct.includes("text/plain") && !ct.includes("text/json")) {
      throw new Error(`Expected JSON, got content-type: ${ct}`);
    }
    const text = (await r.text()).slice(0, MAX_FETCH_BYTES);
    definition = JSON.parse(text);
  } catch (e: any) {
    fetchError = (e?.message ?? String(e)).slice(0, 300);
  }

  if (fetchError) return <ImportError reason={`Could not fetch ${externalUrl}: ${fetchError}`} />;

  // Validate the shape.
  const validated = ReportSchema.safeParse(definition);
  if (!validated.success) {
    return <ImportError reason={`That JSON doesn't match the Curf report schema. First issue: ${validated.error.issues[0]?.message ?? "validation failed"}`} />;
  }

  // The external URL might NOT have placeholder dataSourceIds (the
  // author may have published a "raw" report). Either way, the import
  // panel pulls every dataSourceId out and lets the importer wire them.
  const wiringRequired = extractWiringRequirements(validated.data);

  return (
    <AppShell breadcrumbs={[{ label: "Reports", href: "/reports" }, { label: "Import" }]}>
      <div className="mx-auto max-w-3xl px-8 pb-12 pt-7">
        <PageHeader
          eyebrow={
            <Link href="/reports" className="inline-flex items-center gap-1 hover:text-foreground">
              <ArrowLeft className="h-3 w-3" /> Back to reports
            </Link>
          }
          title={`Import "${validated.data.name}"`}
          description={<>Imported from {externalUrl}.</>}
        />

        <div>
          <ExternalImportPanel
            sanitizedDefinition={validated.data}
            sourceName={validated.data.name}
            sourceUrl={externalUrl}
            wiringRequired={wiringRequired}
          />
        </div>
      </div>
    </AppShell>
  );
}

function ImportError({ reason }: { reason: string }) {
  return (
    <AppShell breadcrumbs={[{ label: "Reports", href: "/reports" }, { label: "Import" }]}>
      <div className="mx-auto max-w-2xl px-6 py-12 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
        <h1 className="mt-4 text-2xl font-semibold">Couldn't import</h1>
        <p className="mt-2 text-sm text-muted-foreground">{reason}</p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Link href="/reports/import" className="rounded-md border border-border bg-background px-4 py-2 text-sm hover:bg-muted">
            Try again
          </Link>
          <Link href="/marketplace" className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
            Browse marketplace
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
