"use client";
/**
 * Mounts the Operate-actions bridge (C1).
 *
 * operate-actions-context.tsx defined the context and the hook and was
 * imported by nothing — blocks could not reach Operate from inside a
 * dashboard or an app, only from a report's drill panel. This is the piece
 * that was missing: it provides the handler, resolves which ActionTemplates
 * apply, and opens the same NewRequestDialog the rest of Operate uses.
 *
 * Flow, mirroring DrillPanel's: a block calls onAction({ row, ... }), we
 * fetch the tenant's chart_click templates, and one match opens the dialog
 * straight away while several offer a picker first. None shows nothing at
 * all — a tenant with no templates gets no affordance, not an empty menu.
 *
 * Renders nothing when no template exists, so wrapping a surface in this is
 * free for tenants that don't use Operate.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  OperateActionsContext, OperateKpiMatchContext, OpenMatchedRequestContext,
  type OperateActionRequest, type OperateKpiMatch,
} from "./operate-actions-context";
import { eeClient } from "@/ee/client";
import { useT } from "@/lib/i18n/LocaleContext";

// Operate is a paid layer: Community renders the "Act" affordances as
// no-ops because the dialog isn't in the build.
const NewRequestDialog = eeClient.operate?.NewRequestDialog ?? null;

/** The clicked row becomes the request's prefill, key for key. */
function prefillFrom(req: OperateActionRequest): Record<string, unknown> {
  const out: Record<string, unknown> = { ...req.row };
  if (req.field && req.value !== undefined) out[req.field] = req.value;
  return out;
}

export function OperateActionsProvider({
  children,
  appId,
}: {
  children: React.ReactNode;
  /**
   * Set when this provider is inside an Analytic App. Stamped onto the
   * request's trigger context so the app's own inbox view (C2) can find the
   * requests raised from it, rather than showing the whole tenant's queue.
   */
  appId?: string;
}) {
  const { t, locale } = useT();
  const [req, setReq] = useState<OperateActionRequest | null>(null);
  const [templates, setTemplates] = useState<any[] | null>(null);
  // The subset of `templates` that actually apply to the report/block the
  // click came from — computed at click time, since that's the first
  // moment reportId/blockId are known (the mount-time fetch below can't
  // filter by them; see that effect's own comment for why it stays
  // tenant-wide instead of per-block).
  const [matched, setMatched] = useState<any[]>([]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  // A drafted recommendation for the open request — inputs merged over the
  // clicked row's own prefill, plus a reason. Fetched once per open from
  // /api/operate/requests/suggest (read-shaped; the model sees the report
  // the click came from). Null until it lands; the form is usable
  // meanwhile and keeps the plain prefill if the model has nothing.
  const [suggestion, setSuggestion] = useState<{ input: Record<string, unknown>; reason: string | null } | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const onAction = useCallback((r: OperateActionRequest) => {
    setReq(r);
    // Click-time matching stays chart_click-only, unchanged — the mount-
    // time fetch below now also pulls in manual/watcher/brief_story
    // templates (for matchKpiOutcome), which must never appear in this
    // picker: a click on a chart bar shouldn't offer a template that was
    // never designed to be scoped by report/block.
    const scoped = (templates ?? []).filter((tpl) =>
      tpl.triggerKind === "chart_click" &&
      eeClient.operate?.matchesChartClickScope(tpl.triggerConfig, { reportId: r.reportId, blockId: r.blockId }),
    );
    setMatched(scoped);
    // One template is not a choice — skip the picker and open it directly.
    setPickedId(scoped.length === 1 ? scoped[0].id : null);
  }, [templates]);

  // Phase 11 (uplift) — the KPI-outcome cross-reference BriefKpiCard's
  // contextual Act button uses to name itself after (and open) the ONE
  // template whose outcome ledger (F5) points at this report/block, via
  // ActionTemplate.outcomeJson rather than chart_click scoping. Pure
  // lookup against the same mount-time list `onAction` reads — no extra
  // fetch, no re-render on click.
  const matchKpiOutcome = useCallback((reportId: string, blockId: string): OperateKpiMatch | null => {
    const tpl = (templates ?? []).find((t) =>
      t.outcome?.kpi?.reportId === reportId && t.outcome?.kpi?.blockId === blockId,
    );
    return tpl ? { templateId: tpl.id, templateName: tpl.name } : null;
  }, [templates]);

  // Opens the dialog directly against a known template — the caller
  // (BriefKpiCard, via matchKpiOutcome) already resolved which one, so
  // this bypasses the chart_click scope picker entirely rather than
  // routing back through onAction()'s scoping filter.
  const openMatchedRequest = useCallback((
    templateId: string, prefillInput: Record<string, unknown>, reportId: string, blockId: string,
  ) => {
    setReq({ reportId, blockId, row: prefillInput });
    setMatched([]);
    setPickedId(templateId);
  }, []);

  // Draft a recommendation the moment a specific template is open for a
  // specific report/block. The KPI tile's prefill is { label, value, delta }
  // (BriefKpiCard), which almost never matches a template's field keys —
  // this is what turns "you clicked NPL exposure" into filled fields and a
  // reason a reviewer can approve on.
  useEffect(() => {
    if (!req || !pickedId || !req.reportId) { setSuggestion(null); setSuggesting(false); return; }
    let cancelled = false;
    setSuggestion(null);
    setSuggesting(true);
    const row = req.row as Record<string, unknown>;
    fetch("/api/operate/requests/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: pickedId,
        reportId: req.reportId,
        blockId: req.blockId,
        ...(appId ? { appId } : {}),
        locale,
        kpi: { label: row.label as string | undefined, value: row.value as string | undefined, delta: (row.delta as string | null | undefined) ?? null },
        prefill: prefillFrom(req),
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j?.status === "ok") setSuggestion({ input: j.input ?? {}, reason: j.reason ?? null }); })
      .catch(() => null)
      .finally(() => { if (!cancelled) setSuggesting(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.reportId, req?.blockId, pickedId]);

  // Resolved once on mount, not per click, and deliberately tenant-wide
  // (no reportId/blockId param) — this provider is mounted once per
  // dashboard/app and serves every block under it over its whole
  // lifetime, so filtering here would mean either N parallel requests on
  // mount (one per block) or a network round-trip on the path to opening
  // a modal on every click. It exists purely to decide whether ANY
  // affordance should render at all: a tenant with no templates
  // must get NO button anywhere — discovering that only after a click
  // would leave a button that visibly does nothing. Which specific
  // templates apply to the report/block actually clicked is resolved
  // from this same list in onAction()/matchKpiOutcome(), above, once
  // reportId/blockId are known.
  //
  // Widened from ?triggerKind=chart_click to every enabled template
  // (Phase 11, uplift) — matchKpiOutcome needs to see manual/watcher/
  // brief_story templates too, since a template's outcome ledger can
  // point at a KPI regardless of what triggers the template itself.
  //
  // `appId` rides along when known: a member's list is unaffected by it,
  // and it's what lets an external viewer's session resolve to that app's
  // grant server-side (the route returns only the templates pointed at
  // the app's own reports for them — see lib/appViewers/appScope.ts).
  const templatesQuery = appId ? `enabledOnly=1&appId=${encodeURIComponent(appId)}` : "enabledOnly=1";
  useEffect(() => {
    if (!eeClient.operate) return; // Operate is paid: no route to ask in Community
    let cancelled = false;
    fetch(`/api/operate/templates?${templatesQuery}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((j) => { if (!cancelled) setTemplates(j.items ?? []); })
      .catch(() => { if (!cancelled) setTemplates([]); });
    return () => { cancelled = true; };
  }, [templatesQuery]);

  // Stable identity: NewRequestDialog re-seeds its inputs whenever this
  // prop changes, so it must only change when the click or the drafted
  // suggestion does — not on every provider render.
  const mergedPrefill = useMemo(
    () => (req ? { ...prefillFrom(req), ...(suggestion?.input ?? {}) } : {}),
    [req, suggestion],
  );

  const showPicker = !!req && !pickedId && matched.length > 1;
  // New edge case scoping introduces: the button-render gate below is
  // still tenant-wide (a block can't know in advance whether ITS report
  // has a matching template), so a deliberate click can now resolve to
  // zero matches once the specific report/block is known — every
  // template that exists is scoped to some other report. Surfaced
  // explicitly rather than silently no-op'd, reusing the picker's own
  // modal shell.
  const showEmpty = !!req && !pickedId && matched.length === 0;

  // null until templates load, and null forever if there are none — blocks
  // treat a null handler as "this surface has no Operate", which is exactly
  // right for a tenant that doesn't use it. Stays tenant-wide (not
  // re-checked per report) for the same reason the mount-time fetch is —
  // see that effect's comment.
  //
  // Gated on chart_click templates specifically (not "any template exists"
  // — the widened fetch above now also returns manual/watcher/brief_story
  // templates that this handler was never meant to surface a button for).
  const hasChartClickTemplates = (templates ?? []).some((tpl) => tpl.triggerKind === "chart_click");
  const handler = hasChartClickTemplates ? onAction : null;

  // Same null-until-resolved contract, gated on whether any template
  // actually carries an outcome cross-reference — a tenant with templates
  // but no outcome ledgers configured gets no contextual Act button either.
  const hasOutcomeTemplates = (templates ?? []).some((tpl) => tpl.outcome);
  const kpiMatchHandler = hasOutcomeTemplates ? matchKpiOutcome : null;
  const openMatchedRequestHandler = hasOutcomeTemplates ? openMatchedRequest : null;

  return (
    <OperateActionsContext.Provider value={handler}>
    <OperateKpiMatchContext.Provider value={kpiMatchHandler}>
    <OpenMatchedRequestContext.Provider value={openMatchedRequestHandler}>
      {children}

      {showPicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setReq(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-sm font-semibold">{t("operateActions.pickTitle")}</h3>
            <p className="mb-3 text-xs text-muted-foreground">{t("operateActions.pickHint")}</p>
            <div className="flex flex-col gap-1">
              {matched.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => setPickedId(tpl.id)}
                  className="rounded-md border border-border px-3 py-2 text-left text-sm hover:border-primary hover:text-primary"
                >
                  {tpl.name}
                  {tpl.description && (
                    <span className="block text-xs text-muted-foreground">{tpl.description}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showEmpty && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setReq(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-sm font-semibold">{t("operateActions.pickTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("operateActions.noneForRecord")}</p>
          </div>
        </div>
      )}

      {NewRequestDialog && <NewRequestDialog
        open={!!req && !!pickedId}
        onClose={() => { setPickedId(null); setReq(null); }}
        onSubmitted={() => { setPickedId(null); setReq(null); }}
        prefillTemplateId={pickedId ?? undefined}
        lockTemplate
        templatesQuery={templatesQuery}
        prefillInput={mergedPrefill}
        prefillReason={suggestion?.reason ?? null}
        suggesting={suggesting}
        triggerContext={
          req
            ? { source: "chart_click", reportId: req.reportId, blockId: req.blockId, value: req.value, ...(appId ? { appId } : {}) }
            : undefined
        }
        title={t("operateActions.dialogTitle")}
      />}
    </OpenMatchedRequestContext.Provider>
    </OperateKpiMatchContext.Provider>
    </OperateActionsContext.Provider>
  );
}
