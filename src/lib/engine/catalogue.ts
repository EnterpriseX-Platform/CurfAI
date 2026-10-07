/**
 * The views a person can build a report on, as the engine shows them to that person.
 *
 * An ordinary person gets summaries of the published views they may query; someone who manages views on the
 * engine gets every view's full definition, drafts included, which is not what a report author needs (a draft
 * cannot be queried). So for managers this keeps only the published views and asks the engine for each one's
 * summary, which says per column whether THIS person receives it masked. Both end as the same small shape,
 * with no SQL, row rules or role lists: an author learns what exists, not how it is protected.
 */
import { engineCall, engineJson, engineStatusError, type EngineCallOptions } from "@/lib/engine/client";

export type CatalogueColumn = { name: string; type: string; label?: string; description?: string; masked: boolean };
export type CatalogueView = { id: string; name: string; description?: string; version: number; columns: CatalogueColumn[] };

const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const SUMMARY_CONCURRENCY = 4;

type Ctx = Pick<EngineCallOptions, "target" | "viewer" | "tenantId" | "fetchImpl">;

export class EngineCatalogueError extends Error {
  constructor(message: string, readonly engineStatus: number) {
    super(message);
  }
}

/** A column as the summary endpoint states it; anything malformed is dropped rather than shown half-formed. */
export function toCatalogueView(raw: any): CatalogueView | null {
  if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string" || !Array.isArray(raw.columns)) return null;
  const columns: CatalogueColumn[] = [];
  for (const c of raw.columns) {
    if (!c || typeof c.name !== "string") continue;
    columns.push({
      name: c.name,
      type: typeof c.type === "string" ? c.type : "unknown",
      ...(typeof c.label === "string" && c.label ? { label: c.label } : {}),
      ...(typeof c.description === "string" && c.description ? { description: c.description } : {}),
      masked: c.masked === true,
    });
  }
  return {
    id: raw.id,
    name: raw.name,
    ...(typeof raw.description === "string" && raw.description ? { description: raw.description } : {}),
    version: typeof raw.version === "number" ? raw.version : 0,
    columns,
  };
}

async function readJson(ctx: Ctx, path: string): Promise<any> {
  const res = await engineCall({ ...ctx, path });
  const problem = await engineStatusError(res);
  if (problem) throw new EngineCatalogueError(problem, res.status);
  return engineJson(res);
}

async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  return out;
}

export async function loadCatalogue(ctx: Ctx): Promise<CatalogueView[]> {
  const first = await readJson(ctx, `/views?page=0&size=${PAGE_SIZE}`);

  // Everyone but a manager: an array of summaries, already the viewer's own.
  if (Array.isArray(first)) {
    return first.map(toCatalogueView).filter((v): v is CatalogueView => v !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  // A manager: pages of full definitions. Keep the published ones and ask for this person's summary of each.
  const published: string[] = [];
  const collect = (page: any) => {
    for (const v of page?.content ?? []) if (v && typeof v.id === "string" && v.publishedVersion != null) published.push(v.id);
  };
  collect(first);
  const totalPages = Math.min(MAX_PAGES, Math.ceil((first?.totalElements ?? 0) / PAGE_SIZE));
  for (let page = 1; page < totalPages; page++) collect(await readJson(ctx, `/views?page=${page}&size=${PAGE_SIZE}`));

  const summaries = await inBatches(published, SUMMARY_CONCURRENCY, async (id) => {
    try {
      return toCatalogueView(await readJson(ctx, `/views/${encodeURIComponent(id)}/summary`));
    } catch (e) {
      // A view that was unpublished between the list and this call is simply not there any more.
      if (e instanceof EngineCatalogueError && e.engineStatus === 404) return null;
      throw e;
    }
  });
  return summaries.filter((v): v is CatalogueView => v !== null).sort((a, b) => a.name.localeCompare(b.name));
}
