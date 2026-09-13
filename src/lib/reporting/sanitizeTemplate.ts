/**
 * Sanitize a Curf report definition for public marketplace publication.
 *
 * The challenge: a Report definition embeds tenant-specific ids
 * (dataSourceId, share tokens, version metadata) and SOMETIMES embeds
 * connection URLs / credentials in REST headers. None of that should
 * leak across tenants.
 *
 * Strategy: a small, opinionated transform that:
 *   1. Walks every DataSourceDef in `dataSources[]` and replaces
 *      `dataSourceId` with a placeholder (`__placeholder__:<kind>`)
 *      while preserving the *kind* so the importer's wiring picker
 *      can suggest connections of the right type.
 *   2. Strips REST `headers` (auth tokens often live there) but keeps
 *      `path` + `body` + `jsonPath` since those are template logic.
 *   3. Strips `attaches[].dataSourceId` + `joins[].queryId` references
 *      that point outside the report (intra-report joins by queryId
 *      are kept — those are template-internal).
 *   4. Preserves block configs verbatim. Block-level tokens (Slack
 *      bot, Anthropic, etc.) are stored on Tenant, never embedded in
 *      the report definition, so this is safe by design.
 *
 * Inverse: cloneIntoTenant() takes a sanitized definition + a mapping
 * of placeholder → real-tenant-dataSourceId and rewrites it back.
 *
 * Schema-shape decision: we keep the placeholder string in the SAME
 * `dataSourceId` field (rather than introducing a new "needsWiring"
 * flag) so the JSON validates against `ReportSchema` without changes.
 * The runner safely treats unknown ids as "data source missing".
 */
import type { Report, DataSourceDef } from "@/lib/reporting/schema";

const PLACEHOLDER_PREFIX = "__placeholder__:";

/** What the importer needs to know to wire each data source up. */
export type WiringRequirement = {
  /** The placeholder token that appears in `dataSourceId`. */
  placeholder: string;
  /** The label from the source — `dataSources[i].name`, e.g. "Marketing warehouse". */
  label: string;
  /** Connector kind hint so the picker can filter to compatible connections. */
  kind: string;
  /** Optional preview SQL or path so the importer sees what this query does. */
  previewQuery?: string;
};

export type SanitizeResult = {
  /** Sanitized definition — safe to publish. Validates against ReportSchema. */
  definition: any;
  /** Stripped tenant-specific bits the importer will need to re-supply. */
  wiringRequired: WiringRequirement[];
};

/** Make a placeholder token from a connector kind hint. Stable per (kind, ix). */
export function placeholderFor(kind: string, ix: number): string {
  return `${PLACEHOLDER_PREFIX}${kind || "unknown"}_${ix}`;
}

export function isPlaceholder(s: string | null | undefined): boolean {
  return !!s && s.startsWith(PLACEHOLDER_PREFIX);
}

/**
 * Build a sanitized copy of `report` ready to publish to the marketplace.
 *
 * `dataSourceKinds` is a map from `dataSourceId` → `kind` from the
 * tenant's DataSource catalog. We can't infer `kind` from the report
 * alone (the def stores only the id), so the caller does one prisma
 * lookup and hands the map in.
 */
export function sanitizeForPublish(opts: {
  report: Report;
  dataSourceKinds: Record<string, string>;
}): SanitizeResult {
  const r = JSON.parse(JSON.stringify(opts.report)) as any; // deep clone

  // Strip the report-level identity bits.
  delete r.id;
  delete r.tenantId;
  delete r.createdById;
  delete r.createdAt;
  delete r.updatedAt;
  delete r.version; // template starts at v1 in the importing tenant

  // Track each unique dataSourceId we encounter so the importer can
  // wire up one connection per real source (not per query).
  const seen = new Map<string, { placeholder: string; kind: string; ix: number }>();
  const wiringRequired: WiringRequirement[] = [];
  let nextIx = 0;

  const placeholderFor1 = (origId: string, kind: string, label: string, previewQuery?: string): string => {
    let entry = seen.get(origId);
    if (!entry) {
      const placeholder = placeholderFor(kind, nextIx++);
      entry = { placeholder, kind, ix: nextIx - 1 };
      seen.set(origId, entry);
      wiringRequired.push({ placeholder, label, kind, previewQuery });
    }
    return entry.placeholder;
  };

  // Walk every DataSourceDef.
  if (Array.isArray(r.dataSources)) {
    for (const ds of r.dataSources as any[]) {
      const origId = String(ds.dataSourceId ?? "");
      const kind = opts.dataSourceKinds[origId] ?? "unknown";
      ds.dataSourceId = placeholderFor1(origId, kind, ds.name ?? origId, ds.sql ?? ds.path);

      // Strip REST headers (auth tokens often live here). Keep the
      // structural fields — path, body, jsonPath — those are template logic.
      if (ds.headers) delete ds.headers;

      // Cross-source ATTACHes — same treatment for each foreign id.
      if (Array.isArray(ds.attaches)) {
        for (const att of ds.attaches) {
          const fId = String(att.dataSourceId ?? "");
          const fKind = opts.dataSourceKinds[fId] ?? "unknown";
          att.dataSourceId = placeholderFor1(fId, fKind, `${ds.name ?? "query"} → ${att.alias}`, undefined);
        }
      }
      // joins[].queryId references another DataSourceDef in this same
      // report by id (template-internal) — preserve as-is. The runner
      // resolves those locally, no tenant context needed.
    }
  }

  return { definition: r, wiringRequired };
}

/**
 * Clone a sanitized template definition back into a real tenant.
 *
 * `wiring` is the importer's choice of which existing tenant DataSource
 * each placeholder maps to. Placeholders not in the map get nulled out
 * (the importer can fix them up later in the designer).
 */
export function cloneIntoTenant(opts: {
  template: any;
  wiring: Record<string, string>; // placeholder → real dataSourceId
}): any {
  const out = JSON.parse(JSON.stringify(opts.template));

  if (Array.isArray(out.dataSources)) {
    for (const ds of out.dataSources as any[]) {
      const ph = String(ds.dataSourceId ?? "");
      if (isPlaceholder(ph)) {
        ds.dataSourceId = opts.wiring[ph] ?? "";
      }
      if (Array.isArray(ds.attaches)) {
        for (const att of ds.attaches) {
          const aPh = String(att.dataSourceId ?? "");
          if (isPlaceholder(aPh)) {
            att.dataSourceId = opts.wiring[aPh] ?? "";
          }
        }
      }
    }
  }

  // Reset identity fields — the importer's tenant assigns its own ids.
  delete out.id;
  out.version = 1;

  return out;
}

/**
 * Rebuild the wiringRequired list from a sanitized template — used by
 * the importer UI to render the "wire up these connections" step
 * without re-running the full sanitize pass.
 */
export function extractWiringRequirements(template: any): WiringRequirement[] {
  const seen = new Map<string, WiringRequirement>();
  if (!Array.isArray(template?.dataSources)) return [];
  for (const ds of template.dataSources as any[]) {
    const ph = String(ds.dataSourceId ?? "");
    if (isPlaceholder(ph) && !seen.has(ph)) {
      seen.set(ph, {
        placeholder: ph,
        label: ds.name ?? ph,
        kind: kindFromPlaceholder(ph),
        previewQuery: ds.sql ?? ds.path,
      });
    }
    if (Array.isArray(ds.attaches)) {
      for (const att of ds.attaches) {
        const aPh = String(att.dataSourceId ?? "");
        if (isPlaceholder(aPh) && !seen.has(aPh)) {
          seen.set(aPh, {
            placeholder: aPh,
            label: `Attach: ${att.alias}`,
            kind: kindFromPlaceholder(aPh),
          });
        }
      }
    }
  }
  return Array.from(seen.values());
}

function kindFromPlaceholder(ph: string): string {
  // __placeholder__:sqlite_0 → sqlite
  const tail = ph.slice(PLACEHOLDER_PREFIX.length);
  const ix = tail.lastIndexOf("_");
  return ix > 0 ? tail.slice(0, ix) : tail;
}

/** URL-safe slug from a name. Falls back to a random id on collision. */
export function slugify(name: string): string {
  const base = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "template";
}
