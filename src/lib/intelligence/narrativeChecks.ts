/**
 * Code checks for words a model wrote for a reader — a report's captions and
 * translations, the Brief's stories, an app's goals. Pure: no server imports,
 * so the gate (reportRules.ts), the Brief (lib/brief.ts) and the Home loader
 * all use the same ones. The rules themselves (what the models are told, what
 * the doc says) live in REPORT_RULES (R29-R32); these are their checks.
 *
 *   - scriptLeaks / cleanScript / pickLocalizedText (R29): text meant for one
 *     language holding a run of another script — "确保การจัดเก็บภาษี…", a
 *     multilingual model's Chinese leaking into a Thai goal (2026-10-23).
 *   - absurdPercents (R30): "+14266.7%", "-14166.7% impact on margin", "484.5%
 *     impact weight" — a share of a near-zero total, true arithmetic and
 *     meaningless to a reader.
 *   - jargonIn (R32): analyst words on an executive surface ("attribution
 *     logic", "near-zero order deltas", "cohort").
 *   - sanitizeNarrative: all three over a paragraph — drop the clause or the
 *     sentence that breaks one, or the whole text when nothing honest is left.
 */

export type NarrativeLocale = "en" | "th" | "zh";

// ── R29: one language, one script ──────────────────────────────────────

/** The script a language is written in. Latin is allowed in every language (names, acronyms, units). */
const NATIVE: Record<NarrativeLocale, RegExp> = {
  en: /\p{Script=Latin}/u,
  th: /\p{Script=Thai}/u,
  zh: /\p{Script=Han}/u,
};
const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;
const LATIN = /\p{Script=Latin}/u;

function isLocale(l: unknown): l is NarrativeLocale {
  return l === "en" || l === "th" || l === "zh";
}

/** A letter that does not belong in `locale`'s text: not its own script, and not Latin. */
function foreignLetter(ch: string, locale: NarrativeLocale): boolean {
  return LETTER.test(ch) && !LATIN.test(ch) && !NATIVE[locale].test(ch);
}

/** Runs of foreign letters (with their combining marks), in order, with where each starts. */
function foreignRuns(text: string, locale: NarrativeLocale): Array<{ run: string; at: number }> {
  const out: Array<{ run: string; at: number }> = [];
  let cur = "", at = -1, i = 0;
  for (const ch of text) {
    if (foreignLetter(ch, locale) || (cur && MARK.test(ch))) {
      if (!cur) at = i;
      cur += ch;
    } else if (cur) {
      out.push({ run: cur, at });
      cur = "";
    }
    i += ch.length;
  }
  if (cur) out.push({ run: cur, at });
  return out;
}

/** Quoted words that may be in any script: a data value, a KPI's own label, a report's name. */
function allowedHaystack(allow?: Iterable<string>): string {
  if (!allow) return "";
  const parts: string[] = [];
  for (const a of allow) if (typeof a === "string" && a.length >= 2) parts.push(a);
  return parts.join("\u0000");
}

/**
 * The runs of another script in text meant for `locale`: Han or kana inside
 * Thai, Thai inside Chinese, Thai or Han inside English. A run that is part of
 * an allowed string (a name from the data, a label the reader already sees) is
 * a quote, not a leak.
 */
export function scriptLeaks(text: string, locale: string, allow?: Iterable<string>): string[] {
  if (!text || !isLocale(locale)) return [];
  const runs = foreignRuns(text, locale);
  if (runs.length === 0) return [];
  const hay = allowedHaystack(allow);
  return runs.map((r) => r.run).filter((r) => !hay.includes(r));
}

/** Share of the letters in `text` that are foreign to `locale` (allowed quotes not counted). */
function foreignShare(text: string, locale: NarrativeLocale, leaks: string[]): number {
  let letters = 0;
  for (const ch of text) if (LETTER.test(ch)) letters++;
  const foreign = leaks.reduce((n, r) => n + [...r].filter((c) => LETTER.test(c)).length, 0);
  return letters === 0 ? 0 : foreign / letters;
}

/**
 * Text for `locale` with leaked runs taken out, when what leaked is a minority
 * ("确保การจัดเก็บภาษี" -> "การจัดเก็บภาษี"); the text itself when nothing leaked;
 * null when most of it is another script (a whole Chinese sentence under th):
 * that is a wrong translation, not a slip, and stripping it leaves nothing.
 */
export function cleanScript(text: string, locale: string, allow?: Iterable<string>): string | null {
  const leaks = scriptLeaks(text, locale, allow);
  if (leaks.length === 0) return text;
  if (foreignShare(text, locale as NarrativeLocale, leaks) > 0.5) return null;
  const hay = allowedHaystack(allow);
  let out = "";
  let last = 0;
  for (const r of foreignRuns(text, locale as NarrativeLocale)) {
    if (hay.includes(r.run)) continue;
    out += text.slice(last, r.at);
    last = r.at + r.run.length;
  }
  out += text.slice(last);
  const tidy = out.replace(/[ \t]{2,}/g, " ").replace(/\(\s*\)|（\s*）/g, "").replace(/^[\s,，、:：;；\-–—]+/, "").trim();
  return /\p{L}|\d/u.test(tidy) ? tidy : null;
}

/**
 * What to show a `locale` reader from a translated map and its base text: the
 * reader's own entry when it is in their script; else the base text; else the
 * English entry; else the reader's entry with the leak taken out; else nothing
 * (a missing description reads better than a garbled one).
 */
export function pickLocalizedText(
  map: Record<string, string> | null | undefined,
  base: string | null | undefined,
  locale: string,
  allow?: Iterable<string>,
): string | null {
  const own = map?.[locale];
  // A plain boolean, not a type guard: a string that fails it is still a string for the cleaning pass below.
  const ok = (s: string | null | undefined): boolean => typeof s === "string" && s.trim().length > 0 && scriptLeaks(s, locale, allow).length === 0;
  if (ok(own)) return own!;
  if (ok(base)) return base!;
  if (ok(map?.en)) return map!.en!;
  for (const s of [own, base]) {
    if (typeof s !== "string" || !s.trim()) continue;
    const cleaned = cleanScript(s, locale, allow);
    if (cleaned) return cleaned;
  }
  return null;
}

// ── R30: figures a reader can't believe ────────────────────────────────

/** A percentage beyond this, either way, is the arithmetic of a near-zero base, not news. */
export const ABSURD_PERCENT = 1000;

const PERCENT_RE = /([+\-−]?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(?:%|％|percent\b|per cent\b|เปอร์เซ็นต์)/giu;
/** Words that make a percentage a share of a whole — above 100% it cannot be one. */
const SHARE_AFTER = /^\s*(?:of\s+(?:the\s+)?(?:total|change|move|swing|drop|rise|gap)|share|weight|contribution|impact\s+weight|ของ(?:ทั้งหมด|การเปลี่ยนแปลง)|สัดส่วน|น้ำหนัก|占比|权重|贡献)/iu;
const SHARE_BEFORE = /(?:share|weight|contribution|accounts?\s+for|explains?|สัดส่วน|น้ำหนัก|คิดเป็น|占比|权重|贡献(?:了|率)?)\s*(?:of\s*)?[:：]?\s*$/iu;

/**
 * The percentages in `text` no reader should be shown: beyond ±1000%, or a
 * share of a whole (weight, contribution, "of the total") above 100%.
 */
export function absurdPercents(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(PERCENT_RE)) {
    const n = Number(m[2]!.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const at = m.index ?? 0;
    const after = text.slice(at + m[0].length, at + m[0].length + 30);
    const before = text.slice(Math.max(0, at - 30), at);
    if (n > ABSURD_PERCENT || (n > 100 && (SHARE_AFTER.test(after) || SHARE_BEFORE.test(before)))) out.push(m[0].trim());
  }
  return out;
}

// ── R32: words for analysts, not executives ────────────────────────────

/**
 * Kept short on purpose: words an executive reader stumbles on and a plain
 * sentence never needs. A word a KPI or report is named with is allowed
 * (a "Cohort retention" card may be called that).
 */
const JARGON: RegExp[] = [
  /\battribution\b/i,
  /\bnear[-\s]zero\b/i,
  /\bdeltas?\b/i,
  /\bcohorts?\b/i,
  /\bp[-\s]?values?\b/i,
  /\bz[-\s]?scores?\b/i,
  /\bstandard\s+deviations?\b/i,
  /\bconfidence\s+intervals?\b/i,
  /\bregression\b/i,
  /\bimpact\s+weights?\b/i,
  /\b(?:numerator|denominator)s?\b/i,
  /\bheteroscedastic|\bmulticollinear/i,
  /แอตทริบิวชัน|โคฮอร์ต|เดลต้า/,
  /归因|同期群|置信区间|标准差/,
];

/** The analyst words in `text`, after taking out the allowed names. */
export function jargonIn(text: string, allow?: Iterable<string>): string[] {
  if (!text) return [];
  let t = text;
  if (allow) for (const a of allow) if (typeof a === "string" && a.length >= 3) t = t.split(a).join(" ");
  const out: string[] = [];
  for (const re of JARGON) { const m = t.match(re); if (m) out.push(m[0]); }
  return out;
}

// ── A paragraph, sentence by sentence ──────────────────────────────────

export type NarrativeProblem = { rule: "R29" | "R30" | "R32"; found: string };

/** Split after a sentence's end mark (". " "! " "? " or a CJK one) or a line break; "14266.7%" stays whole. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|(?<=[。！？])\s*|\n+/u).map((s) => s.trim()).filter(Boolean);
}

const CLAUSE_SPLIT = /\s*[,;，；、]\s*|\s+[—–]\s+/u;

/**
 * `text` for an executive reader in `locale`, with what breaks R29, R30 or R32
 * taken out: a leaked script stripped (or the text refused when it is mostly
 * another script), a clause with an absurd figure or analyst jargon dropped
 * when the sentence still stands without it, else the whole sentence. Null
 * when nothing is left. `jargon: false` skips R32 (text that isn't for an
 * executive surface). `allow`: names (a KPI's label, a report's name) that
 * pass both the script and the jargon check; `quotes`: text whose words may
 * be quoted in any script (the data a story was told from).
 */
export function sanitizeNarrative(
  text: string | null | undefined,
  opts: { locale?: string; allow?: Iterable<string>; quotes?: Iterable<string>; jargon?: boolean } = {},
): { text: string | null; problems: NarrativeProblem[] } {
  const problems: NarrativeProblem[] = [];
  if (typeof text !== "string" || !text.trim()) return { text: null, problems };
  const allow = opts.allow ? [...opts.allow] : undefined;
  // Text a story may quote in any script (a segment name from the data) without that making it a name for R32.
  const quoted = [...(allow ?? []), ...(opts.quotes ? [...opts.quotes] : [])];
  let t = text;
  if (opts.locale) {
    const leaks = scriptLeaks(t, opts.locale, quoted);
    if (leaks.length) {
      problems.push(...leaks.map((found) => ({ rule: "R29" as const, found })));
      const cleaned = cleanScript(t, opts.locale, quoted);
      if (!cleaned) return { text: null, problems };
      t = cleaned;
    }
  }
  const bad = (s: string): NarrativeProblem[] => [
    ...absurdPercents(s).map((found) => ({ rule: "R30" as const, found })),
    ...(opts.jargon === false ? [] : jargonIn(s, allow).map((found) => ({ rule: "R32" as const, found }))),
  ];
  const kept: string[] = [];
  for (const sentence of sentencesOf(t)) {
    const found = bad(sentence);
    if (found.length === 0) { kept.push(sentence); continue; }
    problems.push(...found);
    // The main clause is the first: a sentence keeps going without a later
    // clause ("Sales fell, driven by a -14166.7% impact on margin."), not without its subject.
    const clauses = sentence.split(CLAUSE_SPLIT);
    if (clauses.length > 1 && bad(clauses[0]!).length === 0) {
      const rest = clauses.filter((c) => bad(c).length === 0);
      const end = /[.!?。！？]$/u.test(sentence) ? sentence.slice(-1) : "";
      const joined = rest.join(/[฀-๿]/.test(sentence) ? " " : /[一-鿿]/.test(sentence) ? "，" : ", ").replace(/[.!?。！？]$/u, "");
      kept.push(joined + end);
    }
  }
  // Nothing dropped: the text as written (its line breaks kept).
  if (!problems.some((p) => p.rule !== "R29")) return { text: t, problems };
  const joiner = /[一-鿿]/.test(t) && !/[A-Za-z฀-๿]/.test(t) ? "" : " ";
  const out = kept.join(joiner).trim();
  return { text: out ? out : null, problems };
}

/**
 * A model-written locale map ({ th: "…", zh: "…" }) cleaned at write time (R29):
 * each entry keeps only its own script — a leaked run is stripped, an entry that
 * is mostly another script is dropped (the reader then falls back to the base
 * text). Undefined when nothing usable is left, so the caller writes no map.
 */
export function cleanLocaleMap(map: Record<string, string> | null | undefined): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [locale, text] of Object.entries(map)) {
    if (typeof text !== "string" || !text.trim()) continue;
    const clean = cleanScript(text, locale);
    if (clean && clean.trim()) out[locale] = clean.trim();
  }
  return Object.keys(out).length ? out : undefined;
}
