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
import type { Block, Report } from "./schema";

function localizeBlock(block: Block, locale: string): Block {
  const overrides = block.i18n?.[locale];
  if (!overrides || Object.keys(overrides).length === 0) return block;
  return { ...block, config: { ...block.config, ...overrides } } as Block;
}

/** True if `report` has any i18n content at all — lets callers skip the
 *  work entirely for the (overwhelmingly common, today) case of a report
 *  with no translations authored. */
export function hasLocaleOverrides(report: Report): boolean {
  if (report.nameI18n || report.descriptionI18n) return true;
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
    pages: report.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((b) => localizeBlock(b, locale)),
    })),
  };
}
