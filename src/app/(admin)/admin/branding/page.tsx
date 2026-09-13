/**
 * /admin/branding — tenant-level workspace brand.
 *
 * Admin-only view. The PUT endpoint enforces the gov.custom_branding tier
 * gate (Business); the page renders an upgrade card on Free/Team rather
 * than a half-locked form.
 */
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { tierAtLeast } from "@/lib/billing";
import { BrandingForm } from "./BrandingForm";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

export default async function BrandingPage() {
  const session = await getSession();
  const sessionUser = (session?.user as any) ?? null;
  if (!sessionUser?.id) redirect("/login?callbackUrl=/admin/branding");
  if (sessionUser.role !== "admin") redirect("/reports");

  const tenant = await prisma.tenant.findUnique({
    where: { id: sessionUser.tenantId },
    select: { id: true, name: true, tier: true, brandJson: true } as any,
  });
  let brand: Record<string, unknown> = {};
  try { brand = tenant ? JSON.parse((tenant as any).brandJson || "{}") : {}; } catch {}
  const isBusiness = tierAtLeast((tenant as any)?.tier, "business");

  return (
    <div className="mx-auto max-w-3xl px-8 pb-12 pt-7">
      <PageHeader title={<>Workspace branding</>} description={<>Logo, accent color, the default theme and chart style, and an optional custom palette that overrides the chart colors for everyone in the workspace.</>} />

      {!isBusiness ? (
        <div className="rounded-2xl border border-border bg-muted/30 p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">Business</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">Custom branding is on Business.</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Workspace logo + accent + default theme + a custom 10-color
            palette that follows your brand into every chart.
          </p>
          <a
            href="/admin/billing"
            className="mt-6 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Upgrade to Business
          </a>
        </div>
      ) : (
        <BrandingForm initial={brand as any} />
      )}
    </div>
  );
}
