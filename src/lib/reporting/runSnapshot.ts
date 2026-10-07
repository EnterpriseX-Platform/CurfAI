/**
 * What of a run may be kept in a saved ReportRun.
 *
 * A ReportRun is workspace-wide and read by other people later: replay, the diff page, KPI history, the Brief,
 * Ask, watcher comparisons. A stored row is therefore shown to whoever asks, after a check that can only look at
 * the data source's visibility (lib/reporting/snapshotAccess.ts) — which is right for a database that has one
 * answer for everybody.
 *
 * Engine data does not. The Java engine answers per person: their row rules, their masking. An admin's load
 * holds rows and unmasked columns a colleague must not see, and replaying it would hand them over. There is no
 * check Curf can make later that recovers what the engine would have answered for the reader, so engine data
 * is not kept at all: not its rows, and not the row counts or hashes that describe them.
 *
 * Every place that saves a run's rows goes through snapshotOf(); tests/audit/report-run-engine-data.test.ts
 * fails a new one that does not.
 */
import type { Dataset } from "@/lib/reporting/interpolate";
import type { ProvenanceMap, ProvenanceRecord } from "@/lib/reporting/provenance";

/** A snapshot larger than this keeps metadata only, as before. */
export const SNAPSHOT_MAX_CHARS = 2_000_000;

export const ENGINE_NOT_STORED_NOTE = "Engine data is answered per person, so it is not kept in saved runs.";

/** True when a query's rows came, wholly or partly, from the engine: its own source, or one joined or attached to it. */
export function isEngineDerived(prov: Pick<ProvenanceRecord, "dataSourceKind" | "attachedSources"> | undefined): boolean {
  if (!prov) return false;
  return prov.dataSourceKind === "engine" || (prov.attachedSources ?? []).some((a) => a.kind === "engine");
}

/** The provenance as it may be kept: an engine-derived query keeps its identity but loses what describes its rows. */
export function redactEngineProvenance(provenance: ProvenanceMap | undefined): ProvenanceMap {
  const out: ProvenanceMap = {};
  for (const [id, prov] of Object.entries(provenance ?? {})) {
    out[id] = isEngineDerived(prov) ? { ...prov, rowCount: 0, dataHash: "", accessDeniedNote: ENGINE_NOT_STORED_NOTE } : prov;
  }
  return out;
}

/** The dataset as it may be kept: an engine-derived query's rows are empty. */
export function withoutEngineRows(dataset: Dataset, provenance: ProvenanceMap | undefined): Dataset {
  const out: Dataset = {};
  for (const [id, rows] of Object.entries(dataset)) out[id] = isEngineDerived(provenance?.[id]) ? [] : rows;
  return out;
}

/**
 * The two JSON columns of a ReportRun for this run. The dataset is null when it is too large to keep, and then
 * so is the provenance, as the writers have always done.
 */
export function snapshotOf(dataset: Dataset, provenance: ProvenanceMap | undefined): { dataset: string | null; provenance: string | null } {
  const json = JSON.stringify(withoutEngineRows(dataset, provenance));
  if (json.length >= SNAPSHOT_MAX_CHARS) return { dataset: null, provenance: null };
  return { dataset: json, provenance: JSON.stringify(redactEngineProvenance(provenance)) };
}
