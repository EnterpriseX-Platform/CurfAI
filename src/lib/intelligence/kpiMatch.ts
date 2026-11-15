/**
 * Which KPI a name the brief gave ("average bidders per e-bidding", target >= 4)
 * belongs to. One matcher for the two places that ask it: the delivery check
 * (is the asked KPI on the app?) and the report gate (R12: a KPI the brief gave
 * a target holds it as its plan). Pure: no server imports.
 *
 * A KPI is read in every way it speaks: its label, the label in every language
 * (config.labelI18n and the block's i18n.<locale>.label), its drill-down title,
 * the field it reads. The model words KPIs differently from a brief and in the
 * reader's language, so a name is also matched through a small synonym table
 * (English finance / public-sector words and their Thai and Chinese forms).
 */

const STOP = new Set(["the", "and", "for", "per", "vs", "of", "in", "to", "as", "a", "an", "by", "with", "on", "at", "or", "each", "its", "our", "from", "than", "that", "this", "year", "target", "but", "all"]);

/** Words of a KPI's name that carry its meaning. */
export function kpiTokens(name: string): string[] {
  return [...new Set(name.toLowerCase().split(/[^\p{L}\p{M}\p{N}%]+/u).filter((t) => t.length >= 3 && !STOP.has(t)))];
}

/** A token's 5-letter stem (a longer word matches by its start: bidder / bidders / bidding-no). */
const stem = (t: string): string => (t.length > 5 ? t.slice(0, 5) : t);

/**
 * English stem -> the same idea in Thai, Chinese and common English variants. Substring-matched against the KPI's words.
 * Keyed by the 5-letter stem of the word in the brief.
 */
const SYNONYMS: Record<string, string[]> = {
  savin: ["ประหยัด", "节约", "节省", "saved", "saving"],
  bidde: ["ผู้เสนอราคา", "投标", "bidder"],
  biddi: ["ประมูล", "e-bid", "ebid", "招标", "bidder"],
  singl: ["รายเดียว", "1 ราย", "one bidder", "1 bidder", "单一", "唯一", "single"],
  disbu: ["เบิกจ่าย", "拨付", "支出", "paid", "payment"],
  paid: ["จ่าย", "เบิก", "支付", "disbursed", "disbursement"],
  inves: ["ลงทุน", "投资", "capital"],
  cumul: ["สะสม", "累计", "累積", "ytd", "running"],
  commi: ["ผูกพัน", "承诺", "committed"],
  unpai: ["ยังไม่จ่าย", "ไม่ได้จ่าย", "ค้างจ่าย", "未支付", "not paid", "unpaid"],
  contr: ["สัญญา", "合同", "ลงนาม", "contracted"],
  days: ["วัน", "天", "day"],
  carry: ["กันเหลื่อมปี", "เหลื่อมปี", "结转", "carryover", "carry-over", "carry over"],
  expir: ["หมดอายุ", "到期", "失效", "expire", "expiry"],
  expec: ["คาดว่า", "คาดการณ์", "预计", "expected"],
  reser: ["กันไว้", "กันเงิน", "预留", "reserved"],
  unsig: ["ยังไม่ลงนาม", "ไม่ได้ลงนาม", "ยังไม่ทำสัญญา", "未签", "not signed", "unsigned"],
  share: ["สัดส่วน", "ร้อยละ", "占比", "比例", "ratio"],
  avera: ["เฉลี่ย", "平均", "avg", "mean"],
  price: ["ราคา", "价格", "价"],
  refer: ["ราคากลาง", "อ้างอิง", "参考", "reference"],
  annua: ["ประจำปี", "รายปี", "全年", "annual"],
  budge: ["งบ", "预算", "budget"],
  milli: ["ล้านบาท", "ล้าน", "百万", "million"],
  baht: ["บาท", "泰铢"],
  revenue: ["รายได้", "收入"],
  sales: ["ยอดขาย", "销售"],
  proje: ["โครงการ", "项目", "project"],
  stage: ["ขั้นตอน", "阶段", "stage"],
  delay: ["ล่าช้า", "延迟", "delay"],
  total: ["รวม", "总", "total"],
  count: ["จำนวน", "数量", "count"],
};

/** The wording of a KPI block, in every way it speaks. */
export function kpiVariants(block: unknown, extra: Array<string | null | undefined> = []): string[] {
  const b = (block ?? {}) as any;
  const cfg = b.config ?? {};
  const texts: unknown[] = [cfg.label, ...Object.values(cfg.labelI18n ?? {}), cfg.drilldown?.title, cfg.valueField, cfg.metricKey];
  for (const loc of Object.values(b.i18n ?? {}) as any[]) texts.push(loc?.label, loc?.["drilldown.title"]);
  texts.push(...extra);
  return texts.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.replace(/_/g, " "));
}

/** How much of the asked name a KPI's wording carries, 0..1 (1 = every meaningful word or a synonym of it). */
export function kpiOverlap(name: string, variants: string[] | string): number {
  const tokens = kpiTokens(name);
  if (tokens.length === 0) return 1;
  const hay = (Array.isArray(variants) ? variants.join(" \n ") : variants).toLowerCase();
  const hit = tokens.filter((t) => {
    const s = stem(t);
    return hay.includes(s) || (SYNONYMS[s] ?? []).some((syn) => hay.includes(syn.toLowerCase()));
  }).length;
  return hit / tokens.length;
}

/** The shortest overlap at which a name counts as carried (half its words, by stem or synonym). */
export const KPI_MATCH_MIN = 0.5;

export function kpiMatches(name: string, variants: string[] | string): boolean {
  const tokens = kpiTokens(name);
  if (tokens.length === 0) return true; // nothing to look for: never a reason to fail
  return kpiOverlap(name, variants) >= KPI_MATCH_MIN;
}

// ── Targets the brief gave ──────────────────────────────────────────────

export type KpiAsk = {
  name: string;
  target: string | null;
  /** Other names the same KPI goes by (a governed metric's aliases and its label in each language). */
  names?: string[];
};

export type ParsedTarget = { value: number; percent: boolean; lowerIsBetter: boolean };

/** "≤ 35%" -> 35 percent, lower is better; "100%"; "≥ 4". */
export function parseTargetText(text: string | null | undefined): ParsedTarget | null {
  const m = /^\s*(≥|≤|>=|<=|>|<)?\s*(\d+(?:[.,]\d+)?)\s*(%)?\s*$/.exec(String(text ?? ""));
  if (!m) return null;
  const value = Number(m[2]!.replace(",", "."));
  if (!Number.isFinite(value)) return null;
  return { value, percent: !!m[3], lowerIsBetter: m[1] === "≤" || m[1] === "<=" || m[1] === "<" };
}

/** The target of a governed metric (lib/metrics: in the value's own units, a percent as a fraction) written as a brief writes it. */
export function targetText(target: number | null | undefined, direction: "higher" | "lower" | null | undefined, unit: string): string | null {
  if (typeof target !== "number" || !Number.isFinite(target)) return null;
  const n = unit === "percent" ? Number((target * 100).toPrecision(6)) : target;
  return `${direction === "lower" ? "≤ " : direction === "higher" ? "≥ " : ""}${n}${unit === "percent" ? "%" : ""}`;
}

/** A workspace's governed metrics as asks: each with a target is a KPI whose plan is known (R12), under every name it has. */
export function metricAsks(
  metrics: Array<{ label: string; aliases?: string[]; labelI18n?: Record<string, string>; unit: string; target?: number | null; direction?: "higher" | "lower" | null }>,
  /** Keep a metric with no target, as an ask with none: it claims the KPIs that are it, so they are not matched to another ask's target. */
  opts: { includeUntargeted?: boolean } = {},
): KpiAsk[] {
  return metrics.flatMap((m) => {
    const target = targetText(m.target, m.direction, m.unit);
    return target || opts.includeUntargeted ? [{ name: m.label, target: target ?? null, names: [...(m.aliases ?? []), ...Object.values(m.labelI18n ?? {})] }] : [];
  });
}

/**
 * The asked KPI that a KPI block is, when it is one: the best-matching ask above the threshold, and only when no other
 * ask matches as well (a block that fits two asks equally is not guessed).
 */
export function askFor(variants: string[], asks: KpiAsk[]): KpiAsk | null {
  const scored = asks
    .map((a) => ({ a, s: Math.max(0, ...[a.name, ...(a.names ?? [])].filter((n) => kpiTokens(n).length > 0).map((n) => kpiOverlap(n, variants))) }))
    .filter((x) => x.s >= KPI_MATCH_MIN)
    .sort((x, y) => y.s - x.s);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[1]!.s === scored[0]!.s) return null;
  return scored[0]!.a;
}
