/**
 * Bringing a retail report the pack made earlier up to what the pack makes
 * now, without undoing anything the shop changed. Pure — setup.ts loads the
 * reports, builds the current pack and saves what this returns.
 *
 * A report someone has since edited stays as they left it. What's added:
 *   - queries the current build has and the report doesn't (by id);
 *   - a block's drill (drilldown / drillParam / drillField) when the block
 *     has none and still reads the query the pack gave it;
 *   - translations — a block's, a filter's, the report's own description —
 *     but only a word the report still says the way the pack wrote it, and
 *     never over a translation already there.
 * Titles, SQL, columns, layout: never touched.
 */
import { neededQueries } from "@/lib/reporting/queryRefs";

type Json = Record<string, unknown>;
type I18n = Record<string, Record<string, string>>;
type Block = { id: string; type: string; config?: Json; i18n?: I18n };
type Param = { name: string; label?: string; options?: Array<{ value: string; label: string }>; i18n?: I18n };
export type PackReport = {
  description?: string;
  descriptionI18n?: Record<string, string>;
  parameters?: Param[];
  dataSources: Array<{ id: string } & Json>;
  pages: Array<{ blocks: Block[] } & Json>;
} & Json;

const DRILL_KEYS = ["drilldown", "drillParam", "drillField"] as const;

/** `existing` with what `fresh` (the current build, in the report's own language) adds, or null when nothing would change. */
export function upgradeFromPack<R extends PackReport>(existing: R, fresh: PackReport): R | null {
  let changed = false;
  const freshBlocks = new Map(fresh.pages.flatMap((p) => p.blocks).map((b) => [b.id, b]));

  // Blocks: their drill, then their translations.
  const pages = existing.pages.map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => {
      const twin = freshBlocks.get(block.id);
      if (!twin || twin.type !== block.type || twin.config?.queryId !== block.config?.queryId) return block;
      let config = block.config ?? {};
      if (DRILL_KEYS.every((k) => config[k] === undefined) && DRILL_KEYS.some((k) => twin.config?.[k] !== undefined)) {
        config = { ...config };
        for (const k of DRILL_KEYS) if (twin.config?.[k] !== undefined) config[k] = twin.config[k];
        changed = true;
      }
      const sameY = JSON.stringify(config.yFields) === JSON.stringify(twin.config?.yFields);
      const i18n = mergeWords(block.i18n, twin.i18n, (key) => {
        const mine = at(config, key), theirs = at(twin.config, key);
        // A legend name has no base text: it's the pack's while the series are.
        return mine === undefined ? key.startsWith("seriesLabels.") && sameY && theirs === undefined : mine === theirs;
      });
      if (!i18n.changed && config === block.config) return block;
      if (i18n.changed) changed = true;
      return { ...block, config, ...(i18n.value ? { i18n: i18n.value } : {}) };
    }),
  }));

  // Queries the blocks now read (a new drill's) that the report doesn't have.
  const have = new Set(existing.dataSources.map((d) => d.id));
  const wanted = neededQueries(fresh.dataSources as any, pages);
  const added = fresh.dataSources.filter((d) => !have.has(d.id) && wanted.has(d.id));
  if (added.length) changed = true;

  // Filters: paired by name; an option by its value.
  const parameters = existing.parameters?.map((param) => {
    const twin = fresh.parameters?.find((p) => p.name === param.name);
    if (!twin) return param;
    const i18n = mergeWords(param.i18n, twin.i18n, (key) => {
      if (key === "label") return param.label === twin.label;
      const m = /^options\.(\d+)\.label$/.exec(key);
      if (!m) return false;
      const mine = param.options?.[Number(m[1])], theirs = twin.options?.[Number(m[1])];
      return !!mine && !!theirs && mine.value === theirs.value && mine.label === theirs.label;
    });
    if (!i18n.changed) return param;
    changed = true;
    return { ...param, i18n: i18n.value };
  });

  // The report's own description.
  let descriptionI18n = existing.descriptionI18n;
  if (existing.description === fresh.description && fresh.descriptionI18n) {
    for (const [locale, text] of Object.entries(fresh.descriptionI18n)) {
      if (descriptionI18n?.[locale] !== undefined) continue;
      descriptionI18n = { ...descriptionI18n, [locale]: text };
      changed = true;
    }
  }

  if (!changed) return null;
  return {
    ...existing,
    ...(descriptionI18n ? { descriptionI18n } : {}),
    ...(parameters ? { parameters } : {}),
    dataSources: [...existing.dataSources, ...added],
    pages,
  };
}

/** `mine` plus each of `theirs`' words that `takes(key)` allows and `mine` doesn't already have. */
function mergeWords(mine: I18n | undefined, theirs: I18n | undefined, takes: (key: string) => boolean): { value: I18n | undefined; changed: boolean } {
  let value = mine;
  let changed = false;
  for (const [locale, words] of Object.entries(theirs ?? {})) {
    for (const [key, text] of Object.entries(words)) {
      if (value?.[locale]?.[key] !== undefined || !takes(key)) continue;
      value = { ...value, [locale]: { ...value?.[locale], [key]: text } };
      changed = true;
    }
  }
  return { value, changed };
}

/** The value at a dotted path ("columns.2.label") in a config. */
function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
