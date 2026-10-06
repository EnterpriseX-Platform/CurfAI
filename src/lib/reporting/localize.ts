/**
 * Resolves a report's `i18n`/`nameI18n`/`descriptionI18n` overrides (see
 * BaseBlock and ReportSchema in ./schema.ts) against a target locale.
 *
 * This is content localization — a tenant's own report copy (titles, KPI
 * labels, callout text) — which is a different axis from the app's own UI
 * chrome (nav labels, buttons), covered by lib/i18n/dict.ts. dict.ts has no
 * visibility into Report.definition at all: it's runtime tenant data, not
 * compiled UI strings, so there's nothing equivalent to a static
 * hardcoded-string lint for it. This resolver is what stands in for that —
 * report authors (human or Master Builder) opt individual fields into
 * translation by writing them into `i18n`; anything left unset silently
 * falls back to the base-language `config` value, in every locale.
 */
import type { Block, Parameter, Report } from "./schema";

/**
 * One block with its `locale` overrides in — what localizeReport does to each.
 * A key is a config field ("title"), or a path into one for words that sit
 * inside a list or a map: "columns.2.label" (a table's third header),
 * "referenceLines.0.label", "seriesLabels.new_mrr". A path that points at a
 * list item the config doesn't have is ignored rather than invented.
 */
export function localizeBlock(block: Block, locale: string): Block {
  const overrides = block.i18n?.[locale];
  if (!overrides || Object.keys(overrides).length === 0) return block;
  let config: unknown = block.config;
  for (const [key, text] of Object.entries(overrides)) config = setPath(config, key.split("."), text);
  return { ...block, config } as Block;
}

/** One report filter with its `locale` overrides in: "label", "options.N.label". */
export function localizeParameter(param: Parameter, locale: string): Parameter {
  const overrides = param.i18n?.[locale];
  if (!overrides || Object.keys(overrides).length === 0) return param;
  let out: unknown = param;
  for (const [key, text] of Object.entries(overrides)) {
    const path = key.split(".");
    if (path[path.length - 1] === "label") out = setPath(out, path, text); // never a name, value or default
  }
  return out as Parameter;
}

/** `target` with `text` at `path`, copied along the way — never mutated. */
function setPath(target: unknown, path: string[], text: string): unknown {
  const [head, ...rest] = path as [string, ...string[]];
  if (Array.isArray(target)) {
    const i = Number(head);
    if (!Number.isInteger(i) || i < 0 || i >= target.length) return target;
    const copy = target.slice();
    copy[i] = rest.length ? setPath(target[i], rest, text) : text;
    return copy;
  }
  if (/^\d+$/.test(head)) return target; // an item of a list this config doesn't have
  const obj = target && typeof target === "object" ? (target as Record<string, unknown>) : {};
  return { ...obj, [head]: rest.length ? setPath(obj[head], rest, text) : text };
}

/** The config fields that are words a reader sees, wherever they sit — never a field, id or value the data is matched on. */
const SHOWN = new Set(["title", "subtitle", "text", "label", "emptyText", "caption", "description", "note", "placeholder"]);

type Authored = {
  description?: string;
  descriptionI18n?: Record<string, string>;
  parameters?: Array<{ name: string; label: string; options?: Array<{ value: string; label: string }>; i18n?: Record<string, Record<string, string>> }>;
  pages: Array<{ blocks: Array<{ id: string; config?: unknown; i18n?: Record<string, Record<string, string>> }> }>;
};

/**
 * `base` with the words that read differently in `others` — the same report
 * built in another language (the retail pack writes each from its own
 * strings) — kept as its translations, so a report generated once still
 * reads in every language. Blocks pair by id, a word by its place in the
 * block's config, and only words a reader sees are taken (SHOWN): a column
 * name the other build's SQL called something else becomes the legend's name
 * for it ("seriesLabels.<field>"), never a field to read. The report's own
 * description too, and its filters' labels — a filter pairs by name, an
 * option by its value.
 */
export function withTranslations<R extends Authored>(base: R, others: Record<string, Authored>): R {
  const blocksOf = (r: Authored) => new Map(r.pages.flatMap((p) => p.blocks).map((b) => [b.id, b]));
  const theirs = Object.entries(others).map(([locale, r]) => [locale, blocksOf(r)] as const);
  const descriptionI18n = { ...base.descriptionI18n };
  for (const [locale, r] of Object.entries(others)) if (r.description && r.description !== base.description) descriptionI18n[locale] = r.description;
  const parameters = base.parameters?.map((param) => {
    const i18n = { ...param.i18n };
    for (const [locale, r] of Object.entries(others)) {
      const twin = r.parameters?.find((p) => p.name === param.name);
      if (!twin) continue;
      const words: Record<string, string> = { ...i18n[locale] };
      if (twin.label !== param.label) words.label = twin.label;
      param.options?.forEach((o, i) => {
        const theirs = twin.options?.find((x) => x.value === o.value);
        if (theirs && theirs.label !== o.label) words[`options.${i}.label`] = theirs.label;
      });
      if (Object.keys(words).length) i18n[locale] = words;
    }
    return Object.keys(i18n).length ? { ...param, i18n } : param;
  });
  return {
    ...base,
    ...(Object.keys(descriptionI18n).length ? { descriptionI18n } : {}),
    ...(parameters ? { parameters } : {}),
    pages: base.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => {
        const i18n = { ...block.i18n };
        for (const [locale, other] of theirs) {
          const twin = other.get(block.id);
          if (!twin) continue;
          const words: Record<string, string> = { ...i18n[locale] };
          shownDifferences(block.config, twin.config, [], words);
          const mine = (block.config as { yFields?: unknown })?.yFields, yours = (twin.config as { yFields?: unknown })?.yFields;
          if (Array.isArray(mine) && Array.isArray(yours) && mine.length === yours.length) {
            mine.forEach((f, i) => { if (typeof f === "string" && typeof yours[i] === "string" && yours[i] !== f) words[`seriesLabels.${f}`] = yours[i]; });
          }
          if (Object.keys(words).length) i18n[locale] = words;
        }
        return Object.keys(i18n).length ? { ...block, i18n } : block;
      }),
    })),
  };
}

function shownDifferences(mine: unknown, yours: unknown, path: string[], out: Record<string, string>) {
  if (typeof mine === "string") {
    if (typeof yours === "string" && yours !== mine && SHOWN.has(path[path.length - 1]!)) out[path.join(".")] = yours;
    return;
  }
  if (Array.isArray(mine)) {
    if (Array.isArray(yours) && yours.length === mine.length) mine.forEach((v, i) => shownDifferences(v, yours[i], [...path, String(i)], out));
    return;
  }
  if (mine && typeof mine === "object" && yours && typeof yours === "object") {
    for (const [k, v] of Object.entries(mine)) shownDifferences(v, (yours as Record<string, unknown>)[k], [...path, k], out);
  }
}

/** True if `report` has any i18n content at all — lets callers skip the
 *  work entirely for the (overwhelmingly common, today) case of a report
 *  with no translations authored. */
export function hasLocaleOverrides(report: Report): boolean {
  if (report.nameI18n || report.descriptionI18n) return true;
  if (report.parameters?.some((p) => p.i18n && Object.keys(p.i18n).length > 0)) return true;
  return report.pages.some((p) => p.blocks.some((b) => b.i18n && Object.keys(b.i18n).length > 0));
}

/**
 * Returns `report` with every field that has a `locale` override
 * substituted in. Fields with no override for `locale` (including every
 * field when `locale` matches the base language the report was authored
 * in) pass through unchanged. Never mutates the input.
 */
export function localizeReport(report: Report, locale: string | undefined): Report {
  if (!locale || !hasLocaleOverrides(report)) return report;
  return {
    ...report,
    name: report.nameI18n?.[locale] ?? report.name,
    description: report.descriptionI18n?.[locale] ?? report.description,
    parameters: (report.parameters ?? []).map((p) => localizeParameter(p, locale)),
    pages: report.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((b) => localizeBlock(b, locale)),
    })),
  };
}
