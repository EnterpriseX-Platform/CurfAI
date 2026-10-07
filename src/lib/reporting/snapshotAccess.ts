/**
 * Saved runs, as a reader may see them now.
 *
 * A ReportRun snapshot holds the rows of whoever ran it: an admin's load
 * carries role-restricted sources and unredacted lake columns. Replay, the
 * diff page, KPI history, the Brief's comparison and sparkline, Ask's causal
 * pass, watcher suggestions and a watcher's own diff all read other people's
 * snapshots (or an earlier self's, before a demotion). Each passes the stored
 * rows through the gate a live run applies, as the reader: canSeeDataSource()
 * on the source and on everything it ATTACHed or joined, then lakeGate() for a
 * lake query. So a saved run never shows more than running the report now
 * would.
 *
 * Only what the reader's view of the report reads is kept: its queries and
 * what its blocks name (queryRefs(), e.g. a metric-backed KPI's
 * "metric:<slug>"). Pass the
 * report as visibleReport(definition, viewer), so rows behind blocks hidden
 * from the reader, and queries since removed from the report, are dropped.
 *
 * Where rows came from is read off the run's own provenance (the source's
 * name, unique in a workspace, and its attached/joined sources), not off the
 * report's current definition, which may have changed since. A query whose
 * origin can't be established is withheld rather than guessed at: no
 * provenance, a source since renamed or deleted, a lake query whose SQL has
 * changed since (its redaction depends on the SQL), or a join with a lake
 * source (the joined-in columns can't be re-redacted).
 */
import { prisma } from "@/lib/db";
import { canSeeDataSource } from "@/lib/datasourceAcl";
import { lakeGate, HIDDEN_BY_VISIBILITY, type RunViewer } from "@/lib/reporting/runner";
import { hashQueryDef, type ProvenanceMap, type ProvenanceRecord } from "@/lib/reporting/provenance";
import { metricSlugFromQueryId } from "@/lib/reporting/metricQueryId";
import { ee } from "@/ee";
import { queryRefs } from "@/lib/reporting/queryRefs";
import { ENGINE_NOT_STORED_NOTE, isEngineDerived } from "@/lib/reporting/runSnapshot";
import type { Dataset, Row } from "@/lib/reporting/interpolate";
import type { Report } from "@/lib/reporting/schema";

export const WITHHELD_NOTE = "Not shown — this saved run can't be checked against your current access.";

export type SavedRun = {
  dataset: Dataset;
  provenance: ProvenanceMap;
  params: Record<string, unknown>;
};

type Source = { id: string; kind: string; ownerUserId: string | null; visibleToRolesJson: string | null };
type Gate = Awaited<ReturnType<typeof lakeGate>>;

/**
 * A filter for the saved runs of one report, as `viewer`. Build it once per
 * request and pass every run through it: sources and lake gates are looked up
 * once, not once per run, so a year of KPI history costs a handful of reads.
 */
export function savedRunReader(tenantId: string, report: Report, viewer: RunViewer) {
  const readable = new Set<string>([...report.dataSources.map((q) => q.id), ...queryRefs(report.pages)]);
  const sources = new Map<string, Promise<Source | null>>();
  const gates = new Map<string, Promise<Gate>>();
  const metrics = new Map<string, Promise<{ src: Source | null; sql: string } | null>>();

  const source = (name: string) => {
    if (!sources.has(name)) {
      sources.set(name, prisma.dataSource.findUnique({
        where: { tenantId_name: { tenantId, name } },
        select: { id: true, kind: true, ownerUserId: true, visibleToRolesJson: true },
      }));
    }
    return sources.get(name)!;
  };
  const gate = (sql: string) => {
    if (!gates.has(sql)) gates.set(sql, lakeGate(tenantId, sql, viewer));
    return gates.get(sql)!;
  };
  const metric = (slug: string) => {
    if (!metrics.has(slug)) {
      metrics.set(slug, (async () => {
        // Metrics are a paid module: without it (Community) there is no
        // metric to check against, so the rows are withheld.
        const m = await ee.metrics?.getMetricGateSource(tenantId, slug);
        if (!m) return null;
        const src = await prisma.dataSource.findFirst({
          where: { id: m.dataSourceId, tenantId },
          select: { id: true, kind: true, ownerUserId: true, visibleToRolesJson: true },
        });
        return { src, sql: m.sql };
      })());
    }
    return metrics.get(slug)!;
  };

  /** Rows as the viewer may see them, or the note to show instead. */
  async function allowed(queryId: string, rows: Row[], prov: ProvenanceRecord | undefined, params: Record<string, unknown>): Promise<Row[] | string> {
    // A governed metric's value ("metric:<slug>", from enrichDatasetWithMetrics)
    // has no provenance of its own: gate it by the metric's source and SQL.
    const slug = metricSlugFromQueryId(queryId);
    if (slug) {
      const m = await metric(slug);
      const src = m?.src;
      if (!m || !src) return WITHHELD_NOTE;
      if (!canSeeDataSource(src, viewer)) return HIDDEN_BY_VISIBILITY;
      if (src.kind !== "lake") return rows;
      const g = await gate(m.sql);
      return g.ok ? g.redact(rows) : HIDDEN_BY_VISIBILITY;
    }

    if (!prov) return WITHHELD_NOTE;
    // Engine rows are answered per person (their row rules and masking) and no check made now can recover what
    // the engine would give THIS reader, so they are never replayed — and runSnapshot.ts stops them being stored.
    if (isEngineDerived(prov)) return ENGINE_NOT_STORED_NOTE;
    // Nothing was stored for a query that didn't run: its rows are [].
    if (prov.accessDeniedNote || prov.executionError) return rows;
    const src = await source(prov.dataSourceName);
    if (!src) return WITHHELD_NOTE;
    if (!canSeeDataSource(src, viewer)) return HIDDEN_BY_VISIBILITY;
    for (const attached of prov.attachedSources ?? []) {
      const other = await source(attached.name);
      if (!other) return WITHHELD_NOTE;
      if (!canSeeDataSource(other, viewer)) return HIDDEN_BY_VISIBILITY;
      if (other.kind === "lake") return WITHHELD_NOTE;
    }
    if (src.kind !== "lake") return rows;
    const def = report.dataSources.find((q) => q.id === queryId);
    if (!def || hashQueryDef(def, params) !== prov.queryHash) return WITHHELD_NOTE;
    const g = await gate(def.sql ?? "");
    return g.ok ? g.redact(rows) : HIDDEN_BY_VISIBILITY;
  }

  return async function read(run: SavedRun): Promise<SavedRun> {
    const dataset: Dataset = {};
    const provenance: ProvenanceMap = {};
    for (const [queryId, rows] of Object.entries(run.dataset)) {
      if (!readable.has(queryId)) continue;
      const prov = run.provenance[queryId];
      const result = await allowed(queryId, Array.isArray(rows) ? rows : [], prov, run.params);
      if (typeof result === "string") {
        dataset[queryId] = [];
        provenance[queryId] = { ...(prov ?? blankRecord(queryId)), rowCount: 0, accessDeniedNote: result };
      } else {
        dataset[queryId] = result;
        if (prov) provenance[queryId] = prov;
      }
    }
    return { dataset, provenance, params: run.params };
  };
}

/** Parses a ReportRun row's JSON columns; a malformed column reads as empty. */
export function parseSavedRun(run: { dataset: string | null; provenance?: string | null; params?: string | null }): SavedRun {
  const parse = (s: string | null | undefined) => {
    try { return s ? JSON.parse(s) : {}; } catch { return {}; }
  };
  return { dataset: parse(run.dataset), provenance: parse(run.provenance), params: parse(run.params) };
}

function blankRecord(queryId: string): ProvenanceRecord {
  return {
    queryId, queryName: queryId, queryHash: "", runAt: "", durationMs: 0, rowCount: 0,
    dataHash: "", dataSourceName: "", dataSourceKind: "",
  };
}
