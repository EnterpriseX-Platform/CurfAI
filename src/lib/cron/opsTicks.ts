/**
 * Operations-domain cron tick handlers, extracted verbatim out of
 * src/app/api/cron/tick/route.ts's handle() — see lakeTicks.ts's header
 * comment for why this split exists. No logic changed, just relocated.
 */
import { prisma } from "@/lib/db";
import { cronMatches } from "@/lib/cron/cronMatches";
import { ee } from "@/ee";
import type { FiredItem } from "./types";

// Daily audit-log retention sweep. Runs at 03:00 UTC (one hour after
// the backup sweep so we don't pile up DB pressure). Per-tenant
// retention windows live on Tenant.auditRetentionJson; tenants
// without config are no-ops. Cheap — one distinct-kinds query and
// one DELETE per kind that has a window.
export async function tickAuditRetention(fired: FiredItem[], now: Date, force: boolean): Promise<void> {
  if (!(force || (now.getUTCHours() === 3 && now.getUTCMinutes() === 0))) return;
  try {
    const { sweepAllAuditLogs } = await import("@/lib/audit/retention");
    const r = await sweepAllAuditLogs();
    if (r.totalDeleted > 0) {
      fired.push({
        id: "audit-retention",
        kind: "audit_retention",
        status: "ok",
        narrative: `swept ${r.totalDeleted} audit row${r.totalDeleted === 1 ? "" : "s"} across ${r.tenantCount} tenants`,
      });
    }
  } catch (e: any) {
    console.warn("[cron] audit retention sweep failed:", e?.message);
  }
}

// AI-spend threshold check — every 15 minutes, scan rolling 24h LLM
// cost per tenant against `llmCostThresholdMicroUsd`. Fires the
// `ai.usage.threshold` webhook when crossed, with a 24h debounce on
// `llmCostLastNotifyAt` so a steady-state expensive workload pings
// once per day, not every quarter-hour. Cheap query — one aggregate
// groupBy per pass.
export async function tickAiUsageThreshold(fired: FiredItem[], now: Date, force: boolean): Promise<void> {
  if (!(force || now.getUTCMinutes() % 15 === 0)) return;
  try {
    const { emitWebhook } = await import("@/lib/webhooks");
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const grouped = await prisma.llmTokenUsage.groupBy({
      by: ["tenantId"],
      where: { createdAt: { gte: since } },
      _sum: { microCostUsd: true },
    }).catch(() => [] as any[]);
    // Pull tenants in one batch and join in memory — keeps the cron
    // tick under one round-trip per shape.
    const tenants = await prisma.tenant.findMany({
      select: { id: true, llmCostThresholdMicroUsd: true, llmCostLastNotifyAt: true },
    });
    const byTenant = new Map(grouped.map((g: any) => [g.tenantId, g._sum?.microCostUsd ?? 0]));
    for (const t of tenants) {
      const cost = (byTenant.get(t.id) as number | undefined) ?? 0;
      const threshold = t.llmCostThresholdMicroUsd;
      if (!threshold || cost <= threshold) continue;
      const lastNotify = t.llmCostLastNotifyAt ? new Date(t.llmCostLastNotifyAt as any).getTime() : 0;
      if (now.getTime() - lastNotify < 23 * 60 * 60 * 1000) continue; // 23h debounce
      await prisma.tenant.update({
        where: { id: t.id },
        data: { llmCostLastNotifyAt: now },
      });
      void emitWebhook({
        tenantId: t.id,
        event: "ai.usage.threshold",
        data: {
          windowHours: 24,
          microCostUsd: cost,
          thresholdMicroUsd: threshold,
          usdSpent: Math.round(cost / 10_000) / 100, // human-friendly
          usdThreshold: Math.round(threshold / 10_000) / 100,
        },
      });
      fired.push({ id: t.id, kind: "ai_usage_threshold", status: "ok", narrative: `crossed ${(threshold / 1_000_000).toFixed(2)} USD; rolling 24h = ${(cost / 1_000_000).toFixed(2)}` });
    }
  } catch (e: any) {
    console.warn("[cron] ai-usage threshold check failed:", e?.message);
  }
}

// OWASP A09:2025 — failed logins are recorded (lib/auth.ts authorize()) but
// nobody was ever told when they spike. Edge-triggered on purpose: alert
// once when a (tenant, email) pair's failed-login count crosses the
// threshold inside the current 15-minute window, not on every tick while it
// stays crossed — otherwise a sustained attack would spam the webhook every
// 5 minutes for as long as it runs. Extracted as a pure function so the
// crossing logic itself is unit-testable without a database.
export function shouldAlertOnFailedLogins(currentCount: number, previousCount: number, threshold = 5): boolean {
  return currentCount >= threshold && previousCount < threshold;
}

// Alerts on three channels: the security.suspicious_login webhook (for
// tenants with a Slack/webhook integration wired up), a direct email to
// every admin in the affected tenant (so a tenant with no integration
// configured still gets told), and an Operate Inbox item (so it's visible
// in-app too, not just external channels).
export async function tickSecurityAlerts(fired: FiredItem[], now: Date, force: boolean): Promise<void> {
  if (!(force || now.getUTCMinutes() % 5 === 0)) return;
  const WINDOW_MS = 15 * 60_000;
  try {
    const { emitWebhook } = await import("@/lib/webhooks");
    const { sendEmail } = await import("@/lib/delivery/email");
    const currentSince = new Date(now.getTime() - WINDOW_MS);
    const previousSince = new Date(now.getTime() - 2 * WINDOW_MS);
    const [current, previous] = await Promise.all([
      prisma.auditEvent.groupBy({
        by: ["tenantId", "userEmail"],
        where: { kind: "signin.failed", createdAt: { gte: currentSince } },
        _count: { _all: true },
      }),
      prisma.auditEvent.groupBy({
        by: ["tenantId", "userEmail"],
        where: { kind: "signin.failed", createdAt: { gte: previousSince, lt: currentSince } },
        _count: { _all: true },
      }),
    ]).catch(() => [[], []] as [any[], any[]]);
    const prevCounts = new Map(previous.map((p: any) => [`${p.tenantId}:${p.userEmail}`, p._count._all as number]));
    for (const c of current as any[]) {
      if (!c.userEmail) continue;
      const prevCount = prevCounts.get(`${c.tenantId}:${c.userEmail}`) ?? 0;
      if (!shouldAlertOnFailedLogins(c._count._all, prevCount)) continue;
      void emitWebhook({
        tenantId: c.tenantId,
        event: "security.suspicious_login",
        data: { userEmail: c.userEmail, failedCount: c._count._all, windowMinutes: 15 },
      });

      // Webhook only reaches tenants that bothered to wire one up — every
      // tenant has admins, so email them directly too, same as the
      // decision-outcome notify in lib/decisions/resolve.ts.
      const adminMemberships = await prisma.membership.findMany({
        where: { tenantId: c.tenantId, role: "admin" },
        select: { user: { select: { email: true } } },
      });
      const admins = adminMemberships.map((m: any) => m.user);
      if (admins.length) {
        const text =
          `พบความพยายาม login ผิดพลาด ${c._count._all} ครั้งภายใน 15 นาที สำหรับบัญชี ${c.userEmail} ` +
          `— อาจเป็นการโจมตีแบบเดารหัสผ่านซ้ำๆ (credential stuffing) กรุณาตรวจสอบ`;
        void sendEmail({
          to: admins.map((a: any) => a.email),
          subject: `[แจ้งเตือนความปลอดภัย] Login ผิดพลาดผิดปกติ — ${c.userEmail}`,
          text,
          html: `<p>${text}</p>`,
          tenantId: c.tenantId,
        }).catch(() => null); // best-effort — a failed email shouldn't block the webhook/audit trail above
      }

      // Third channel: put it in the Operate Inbox too, so it's visible in
      // the app itself, not just Slack/webhook/email — auto-provisions a
      // "Security alert" template on first fire per tenant (see hooks.ts).
      // Operate is a paid layer; in Community the webhook and email above
      // are the whole alert.
      void ee.cron?.fireSecurityAlert?.({
        tenantId: c.tenantId,
        userEmail: c.userEmail,
        failedCount: c._count._all,
        windowMinutes: 15,
      })?.catch((e: any) => console.warn("[cron] security alert Operate request failed:", e?.message));

      fired.push({
        id: `${c.tenantId}:${c.userEmail}`,
        kind: "security_alert",
        status: "ok",
        narrative: `${c.userEmail}: ${c._count._all} failed logins in 15m`,
      });
    }
  } catch (e: any) {
    console.warn("[cron] security alert scan failed:", e?.message);
  }
}
