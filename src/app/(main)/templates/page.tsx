import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";
import { TEMPLATES } from "@/lib/templates/registry";
import { TemplateGallery } from "./TemplateGallery";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const session = await getSession();
  if (!session) redirect("/login?callbackUrl=/templates");
  return (
    <AppShell breadcrumbs={[{ label: "Templates" }]}>
      <TemplateGallery templates={TEMPLATES.map((t) => {
        const built = t.build();
        return {
          slug: t.slug,
          industry: t.industry,
          icon: t.icon,
          accent: t.accent,
          title: t.title,
          description: t.description,
          blocks: built.pages[0]?.blocks ?? [],
        };
      })} />
    </AppShell>
  );
}
