/**
 * Shared empty/unavailable-state frame — one look for every "there's
 * nothing here yet" moment instead of four hand-rolled copies
 * (BlockEmptyState, the app's ViewUnavailable/SignInRequired, AppInbox's
 * own empty block) that had each drifted their own radius/padding/roundel
 * rules. Server-safe on purpose: no hooks, no client context, so it can
 * render from a Server Component the same way BlockEmptyState always has
 * to (a public app's report tree renders server-side).
 *
 * Copy arrives pre-translated — this component does no i18n lookup of its
 * own, so it never needs a `locale` prop threaded through it. Callers
 * resolve `t(locale, "...")` (server) or `t("...")` (client) before
 * passing `title`/`description` in.
 */
export function EmptyState({
  icon, title, description, action, preview, tone = "dashed", className,
}: {
  /** A rendered icon element, e.g. <Inbox className="h-5 w-5" /> — not a
   *  component reference, so the caller controls size/stroke like every
   *  other icon usage in the app. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** A button/link — "jump to the tab that fills this", "connect an AI
   *  key", etc. Omitted when there's genuinely no next action. */
  action?: React.ReactNode;
  /** Extra content below the description/action — e.g. a "Connect a key
   *  in Tenant Settings → LLM" link distinct from the primary action. */
  preview?: React.ReactNode;
  /** "dashed" (default): the quiet, still-loading-eventually look — a
   *  report block or list with no rows yet. "card": a solid bordered card
   *  for a state that needs more visual weight, e.g. "no AI connected". */
  tone?: "dashed" | "card";
  className?: string;
}) {
  const frame = tone === "card"
    ? "border-border bg-card shadow-xs"
    : "border-dashed border-border bg-muted/20";
  return (
    <div className={["rounded-report border p-8 text-center", frame, className].filter(Boolean).join(" ")}>
      {icon && (
        <div
          className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full"
          style={{
            background: "var(--app-accent-soft, hsl(var(--primary) / 0.1))",
            color: "var(--app-accent, hsl(var(--primary)))",
          }}
        >
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
      {preview && <div className="mt-3">{preview}</div>}
    </div>
  );
}
