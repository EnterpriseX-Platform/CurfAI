/**
 * Refine the generic "manual" sourceKind into a more specific, honest
 * origin for display.
 *
 * LakeTable.sourceKind is a narrow enum ("upload" | "webhook" | "rest_pull"
 * | "sftp_pull" | "manual") with no room for Master Builder, an
 * incremental sync, a saved result (materialized view), a pipeline step,
 * or a workspace-template seed without a schema migration — so every one
 * of those writes through createOrReplaceTable/upsertLakeRowsByKey with
 * sourceKind: "manual". Each of them already stashes a provenance hint in
 * sourceConfigJson, though; this reads that hint back out instead of
 * adding a new column. A table nobody actually touched by hand — created
 * by POSTing {name, rows} straight to the API — has no such hint, and
 * "Manual" is the correct label for it.
 */
export type RefinedOrigin = {
  /** i18n key — caller resolves via its own t(). */
  labelKey: string;
  /** Plain-text detail already present in the data (a source table or
   *  object name) — never translated. */
  detail?: string;
};

export function refineManualOrigin(
  sourceKind: string,
  sourceConfig: Record<string, unknown> | null | undefined,
): RefinedOrigin | null {
  if (sourceKind !== "manual" || !sourceConfig) return null;
  const cfg = sourceConfig;

  if (cfg.kind === "cdc") {
    return { labelKey: "tables.source.cdc", detail: str(cfg.sourceTable) };
  }
  if (cfg.kind === "materialized_view") {
    return { labelKey: "tables.source.materializedView" };
  }
  if (cfg.provenance === "master-builder") {
    return { labelKey: "tables.source.masterBuilder" };
  }
  if (cfg.provenance === "pipeline") {
    return { labelKey: "tables.source.pipeline" };
  }
  if (cfg.provenance === "workspace-template") {
    return { labelKey: "tables.source.workspaceTemplate" };
  }
  if (cfg.provenance === "retail-metrics") {
    return { labelKey: "tables.source.retailMetrics" };
  }
  if (cfg.provenance === "sync") {
    const detail = str(cfg.sourceObject);
    switch (str(cfg.connectorKind)) {
      case "line":       return { labelKey: "tables.source.syncLine" };
      case "postgres":   return { labelKey: "tables.source.syncPostgres", detail };
      case "salesforce": return { labelKey: "tables.source.syncSalesforce", detail };
      case "stripe":     return { labelKey: "tables.source.syncStripe", detail };
      default:           return { labelKey: "tables.source.sync", detail };
    }
  }
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
