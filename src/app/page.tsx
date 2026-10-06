import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth";
import { landingPathFor } from "@/lib/roles";
import { LandingShell } from "./LandingShell";
import { TEMPLATES } from "@/lib/templates/registry";
import { BlockSchema } from "@/lib/reporting/schema";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await readSession();
  
  // The one landing decision for signed-in members (login defaults here too).
  if (session) {
    redirect(landingPathFor((session.user as any)?.role));
  }

  // Read at request-time from the server env — no NEXT_PUBLIC_ needed, no build-time baking.
  // Set DOCS_URL in the k8s Deployment env to override; falls back to same-domain /docs
  // (empty string so docsLink()'s "${docsUrl}/docs${path}" resolves relative to whatever
  // host is currently serving the page, instead of a hardcoded external domain).
  const docsUrl = process.env.DOCS_URL ?? "";
  return (
    <LandingShell
      signedIn={false}
      userName={null}
      docsUrl={docsUrl}
      blockTypeCount={BlockSchema.options.length}
      teaserTemplates={TEMPLATES.slice(0, 3).map((t) => {
        const built = t.build();
        return {
          slug: t.slug, icon: t.icon,
          title: t.title, description: t.description, industry: t.industry,
          blocks: built.pages[0]?.blocks ?? [],
        };
      })}
    />
  );
}
