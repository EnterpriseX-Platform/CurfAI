/**
 * Outbound webhook event taxonomy.
 *
 * Adding a new event:
 *   1. Append to EVENT_REGISTRY below with a stable id + payload sketch
 *   2. Call emitWebhook({ tenantId, event: "your.event", data: {...} })
 *      from the emission point
 *   3. The dispatcher (lib/webhooks/dispatcher.ts) takes care of fanout,
 *      signing, retry, and audit-trail persistence
 *
 * Stability rule: event ids and payload field names are PUBLIC API. Once
 * shipped, treat them like a REST endpoint contract — additive changes
 * only. Adding a field is fine; removing or renaming one is a breaking
 * change that requires a v2 event ("watcher.fired.v2") + deprecation.
 */

export type WebhookEvent = {
  /** Stable dot-namespaced id ("watcher.fired"). */
  id: string;
  /** Human-readable label shown in the multi-select. */
  label: string;
  /** One-line description shown next to the checkbox. */
  description: string;
  /** Family group used for the picker UI. */
  family: "report" | "watcher" | "lake" | "comment" | "publish" | "ai" | "dq" | "operate" | "security";
  /** Sample payload — copied into the admin "Try a sample delivery" feature. */
  samplePayload: Record<string, unknown>;
};

export const EVENT_REGISTRY: WebhookEvent[] = [
  {
    id: "report.created",
    label: "Report created",
    description: "Fires when any new report is saved (UI, generate, or auto-curf).",
    family: "report",
    samplePayload: {
      reportId: "rep_abc123",
      reportName: "Q4 Marketing Spend",
      createdBy: "alice@example.com",
      via: "auto-curf",
    },
  },
  {
    id: "report.updated",
    label: "Report updated",
    description: "Fires on definition or metadata change. Throttled to one per report per minute.",
    family: "report",
    samplePayload: {
      reportId: "rep_abc123",
      reportName: "Q4 Marketing Spend",
      version: 7,
      updatedBy: "alice@example.com",
    },
  },
  {
    id: "report.deleted",
    label: "Report deleted",
    description: "Fires after a hard delete. The reportId will resolve to a 404 by the time you see it.",
    family: "report",
    samplePayload: { reportId: "rep_abc123", deletedBy: "alice@example.com" },
  },
  {
    id: "watcher.fired",
    label: "Watcher fired",
    description: "An anomaly threshold was crossed. Includes the metric, current/previous values, and severity.",
    family: "watcher",
    samplePayload: {
      watcherId: "wat_xyz",
      reportId: "rep_abc123",
      reportName: "Q4 Marketing Spend",
      blockTitle: "Search ROI",
      metric: "roi",
      previous: 4.2,
      current: 3.1,
      deltaPct: -0.262,
      severity: "high",
    },
  },
  {
    id: "lake.backup.shipped",
    label: "Backup shipped off-site",
    description: "An auto or manual snapshot reached an off-site destination (S3, R2, Azure, etc.).",
    family: "lake",
    samplePayload: {
      backupId: "bkp_def",
      destinationName: "Acme S3 — us-east-1",
      bytesSent: 1_245_678,
      durationMs: 842,
      status: "ok",
    },
  },
  {
    id: "lake.backup.failed",
    label: "Backup ship failed",
    description: "An off-site shipment failed. Useful to alert ops on a flapping destination.",
    family: "lake",
    samplePayload: {
      backupId: "bkp_def",
      destinationName: "Acme S3 — us-east-1",
      error: "HTTP 403: SignatureDoesNotMatch",
      attempt: 1,
    },
  },
  {
    id: "lake.mv.failed",
    label: "Materialized view refresh failed",
    description: "An MV cron refresh hit an error. Includes the SQL error string for triage.",
    family: "lake",
    samplePayload: {
      mvId: "mv_ghi",
      mvName: "daily_revenue_summary",
      error: "no such column: foo",
      durationMs: 312,
    },
  },
  {
    id: "comment.posted",
    label: "Comment posted",
    description: "A reviewer left a comment on a report block. Includes @mentions if present.",
    family: "comment",
    samplePayload: {
      commentId: "cmt_jkl",
      reportId: "rep_abc123",
      blockId: "blk_mno",
      author: "bob@example.com",
      body: "Why is Display down 30%?",
      mentions: ["alice@example.com"],
    },
  },
  {
    id: "publish.app.created",
    label: "Public app published",
    description: "A report was promoted to a public-facing app via the Publish flow.",
    family: "publish",
    samplePayload: {
      appId: "app_pqr",
      slug: "q4-marketing-recap",
      reportId: "rep_abc123",
      url: "https://curf.example.com/apps/q4-marketing-recap",
    },
  },
  {
    id: "ai.usage.threshold",
    label: "AI spend threshold crossed",
    description: "Fires when the rolling 24h LLM spend crosses a configurable USD threshold (default $10).",
    family: "ai",
    samplePayload: {
      windowHours: 24,
      microCostUsd: 12_500_000,
      thresholdMicroUsd: 10_000_000,
      provider: "anthropic",
    },
  },
  {
    id: "dq.failed",
    label: "Data quality check failed",
    description: "A scheduled assertion (not_null, unique, monotonic, schema drift, custom SQL) returned violations. Severity comes from the check's config (warning is logged only and doesn't emit).",
    family: "dq",
    samplePayload: {
      checkId: "dq_abc",
      checkName: "orders.customer_id_not_null",
      tableName: "orders",
      observedValue: 12,
      expectedValue: 0,
      severity: "error",
    },
  },
  {
    id: "marketplace.template.updated",
    label: "Subscribed template updated",
    description: "A marketplace template you've subscribed to has a new version available.",
    family: "publish",
    samplePayload: {
      templateSlug: "saas-mrr-weekly",
      templateName: "SaaS MRR + churn weekly",
      newVersion: 3,
      previousVersion: 2,
      changelog: "Added Q4 cohort breakdown chart",
      authorName: "Mercury Labs",
      url: "https://curf.example.com/marketplace/saas-mrr-weekly",
    },
  },
  {
    id: "operate.sla.breached",
    label: "Action SLA breached",
    description:
      "An Operate request or approval step blew past its SLA. Includes the request id, template, current step, and how long over.",
    family: "operate",
    samplePayload: {
      requestId: "req_abc123",
      templateSlug: "approve-refund-1k",
      templateName: "Approve Refund > $1k",
      kind: "step", // "step" | "request"
      step: 1,
      stepLabel: "Finance review",
      overdueMinutes: 47,
      escalatedTo: "finance-lead@example.com",
    },
  },
  {
    id: "security.suspicious_login",
    label: "Suspicious login activity",
    description: "Fires once when a single account crosses 5 failed logins within a 15-minute window (credential-stuffing / brute-force pattern).",
    family: "security",
    samplePayload: {
      userEmail: "alice@example.com",
      failedCount: 6,
      windowMinutes: 15,
    },
  },
  {
    id: "marketplace.author.published",
    label: "Followed author published",
    description: "A marketplace author you follow published a new template or collection.",
    family: "publish",
    samplePayload: {
      authorSlug: "mercury-labs",
      authorName: "Mercury Labs",
      kind: "template",
      slug: "deploy-frequency-weekly",
      name: "Deploy frequency weekly",
      url: "https://curf.example.com/marketplace/deploy-frequency-weekly",
    },
  },
];

const REGISTRY_BY_ID = new Map(EVENT_REGISTRY.map((e) => [e.id, e]));

export function getEvent(id: string): WebhookEvent | null {
  return REGISTRY_BY_ID.get(id) ?? null;
}

/** All known event ids — used to validate the create form. */
export function knownEventIds(): string[] {
  return EVENT_REGISTRY.map((e) => e.id);
}

/** Group events by family for the admin picker UI. */
export function groupedEvents(): Array<{ family: string; events: WebhookEvent[] }> {
  const groups = new Map<string, WebhookEvent[]>();
  for (const e of EVENT_REGISTRY) {
    const arr = groups.get(e.family) ?? [];
    arr.push(e);
    groups.set(e.family, arr);
  }
  return Array.from(groups.entries()).map(([family, events]) => ({ family, events }));
}
