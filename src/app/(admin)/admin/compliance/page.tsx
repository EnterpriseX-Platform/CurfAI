/**
 * /admin/compliance — security + compliance posture summary.
 *
 * Designed to be the single page a security questionnaire reviewer can
 * deeplink to. Honest about what we DO and what we DON'T do yet — the
 * latter section is just as important as the former so prospects don't
 * get blindsided after signing.
 *
 * Updated whenever Phase 2/3 of the data-layer roadmap ships features
 * — see ROADMAP-DATA-LAYER.md.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { Check, AlertTriangle, Clock, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export default async function CompliancePage() {
  const user = await requireUser();
  if (!user) redirect("/login?next=/admin/compliance");
  if (user.role !== "admin") redirect("/");

  const locale = readLocale();

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.section.admin"), href: "/admin/tenant" }, { label: t(locale, "nav.compliance") }]}>
      <div className="mx-auto max-w-4xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "admin.compliance.title")} description={t(locale, "admin.compliance.subtitle")} />


        <Section title={t(locale, "admin.compliance.section.today")}>
          <Item
            kind="ok"
            title={t(locale, "admin.compliance.item.tenantIsolation.title")}
            body={t(locale, "admin.compliance.item.tenantIsolation.body")}
          />
          <Item
            kind="ok"
            title={t(locale, "admin.compliance.item.secretsEncryption.title")}
            body={t(locale, "admin.compliance.item.secretsEncryption.body")}
          />
          <Item
            kind="ok"
            title={t(locale, "admin.compliance.item.webhookHmac.title")}
            body={t(locale, "admin.compliance.item.webhookHmac.body")}
          />
          <Item
            kind="ok"
            title={t(locale, "admin.compliance.item.auditLog.title")}
            body={t(locale, "admin.compliance.item.auditLog.body")}
          />
          <Item
            kind="ok"
            title={t(locale, "admin.compliance.item.lakeBackups.title")}
            body={t(locale, "admin.compliance.item.lakeBackups.body")}
          />
          <Item
            kind="ok"
            title={t(locale, "admin.compliance.item.lakeRls.title")}
            body={t(locale, "admin.compliance.item.lakeRls.body")}
          />
          <Item
            kind="ok"
            title={t(locale, "admin.compliance.item.schemaMigrations.title")}
            body={t(locale, "admin.compliance.item.schemaMigrations.body")}
          />
          <Item
            kind="ok"
            title={t(locale, "admin.compliance.item.noThirdPartyAi.title")}
            body={t(locale, "admin.compliance.item.noThirdPartyAi.body")}
          />
          <Item
            kind="ok"
            title={t(locale, "admin.compliance.item.exportDeletion.title")}
            body={t(locale, "admin.compliance.item.exportDeletion.body")}
          />
          <Item
            kind="ok"
            title={t(locale, "admin.compliance.item.pdpaRecord.title")}
            body={t(locale, "admin.compliance.item.pdpaRecord.body")}
          />
          <Item
            kind="ok"
            title={t(locale, "admin.compliance.item.restReadOnly.title")}
            body={t(locale, "admin.compliance.item.restReadOnly.body")}
          />
        </Section>

        <Section title={t(locale, "admin.compliance.section.inProgress")}>
          <Item
            kind="wip"
            title={t(locale, "admin.compliance.item.offsiteBackup.title")}
            body={t(locale, "admin.compliance.item.offsiteBackup.body")}
          />
          <Item
            kind="wip"
            title={t(locale, "admin.compliance.item.piiTagging.title")}
            body={t(locale, "admin.compliance.item.piiTagging.body")}
          />
          <Item
            kind="wip"
            title={t(locale, "admin.compliance.item.costTelemetry.title")}
            body={t(locale, "admin.compliance.item.costTelemetry.body")}
          />
        </Section>

        <Section title={t(locale, "admin.compliance.section.gaps")}>
          <Item
            kind="gap"
            title={t(locale, "admin.compliance.item.soc2.title")}
            body={t(locale, "admin.compliance.item.soc2.body")}
          />
          <Item
            kind="gap"
            title={t(locale, "admin.compliance.item.hipaa.title")}
            body={t(locale, "admin.compliance.item.hipaa.body")}
          />
          <Item
            kind="gap"
            title={t(locale, "admin.compliance.item.residency.title")}
            body={t(locale, "admin.compliance.item.residency.body")}
          />
          <Item
            kind="gap"
            title={t(locale, "admin.compliance.item.ssoCustomIdp.title")}
            body={t(locale, "admin.compliance.item.ssoCustomIdp.body")}
          />
        </Section>

        <Section title={t(locale, "admin.compliance.section.surface")}>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t(locale, "admin.compliance.surface.intro")} <code className="font-mono text-xs">User</code>,{" "}
            <code className="font-mono text-xs">Tenant</code>,{" "}
            <code className="font-mono text-xs">DataSource</code> {t(locale, "admin.compliance.surface.connectionStrings")},{" "}
            <code className="font-mono text-xs">LakeTable</code> + <code className="font-mono text-xs">LakeIngestToken</code>,{" "}
            <code className="font-mono text-xs">SlackInstallation</code> {t(locale, "admin.compliance.surface.botTokens")},{" "}
            <code className="font-mono text-xs">ApiKey</code>,{" "}
            <code className="font-mono text-xs">Comment</code>,{" "}
            <code className="font-mono text-xs">AskConversation</code>.{" "}
            {(() => {
              const outro = t(locale, "admin.compliance.surface.outro");
              const [pre, post] = outro.split("{code}");
              return (
                <>
                  {pre}
                  <code className="font-mono text-xs">@@unique([tenantId, ...])</code>
                  {post}
                </>
              );
            })()}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            {t(locale, "admin.compliance.surface.roadmapPre")} <a href="/ROADMAP-DATA-LAYER.md" className="text-primary hover:underline">ROADMAP-DATA-LAYER.md</a> {t(locale, "admin.compliance.surface.roadmapPost")}
          </p>
        </Section>

        <div className="mt-10 rounded-lg border border-border bg-muted/40 p-5 text-xs text-muted-foreground">
          <p>
            {t(locale, "admin.compliance.questionsIntro")}
          </p>
          <ul className="mt-2 list-disc space-y-0.5 pl-6">
            <li>{t(locale, "admin.compliance.q.subprocessors")}</li>
            <li>{t(locale, "admin.compliance.q.incidentResponse")}</li>
            <li>{t(locale, "admin.compliance.q.pentest")}</li>
            <li>{t(locale, "admin.compliance.q.bugBounty")}</li>
          </ul>
          <p className="mt-3">
            {t(locale, "admin.compliance.reachTeam")} <a href="mailto:security@curf.ai" className="text-primary hover:underline">security@curf.ai</a>
          </p>
        </div>
      </div>
    </AppShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Item({ kind, title, body }: { kind: "ok" | "wip" | "gap"; title: string; body: string }) {
  const tone = kind === "ok"
    ? { icon: <Check className="h-3.5 w-3.5 text-success" />, ring: "ring-success/20" }
    : kind === "wip"
    ? { icon: <Clock className="h-3.5 w-3.5 text-warning" />, ring: "ring-warning/20" }
    : { icon: <AlertTriangle className="h-3.5 w-3.5 text-destructive" />, ring: "ring-destructive/20" };
  return (
    <div className={`rounded-md border border-border bg-card p-4 ring-1 ${tone.ring}`}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">{tone.icon}</span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</p>
        </div>
      </div>
    </div>
  );
}
