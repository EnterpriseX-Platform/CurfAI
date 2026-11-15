/**
 * Platform AI spend grouped by feature, for /admin/platform/ai-costs. A usage row's kind is "<feature>[.<part>][.repair]":
 * the parts of one feature (master_builder_design_staged.foundation, .reports, .surface) fold into it, and a ".repair" call
 * is counted as repair spend of that feature, so the page can show how much of a feature's cost is paying for retries.
 * Pure.
 */
export type KindCost = { kind: string; calls: number; micro: number };
export type FeatureCost = { feature: string; calls: number; micro: number; repairMicro: number; repairShare: number; perCall: number; shareOfTotal: number };

export function featureOf(kind: string): { feature: string; repair: boolean } {
  const parts = kind.split(".");
  return { feature: parts[0], repair: parts.slice(1).includes("repair") };
}

export function costByFeature(rows: KindCost[]): FeatureCost[] {
  const by = new Map<string, { calls: number; micro: number; repairMicro: number }>();
  let total = 0;
  for (const r of rows) {
    const { feature, repair } = featureOf(r.kind);
    const f = by.get(feature) ?? { calls: 0, micro: 0, repairMicro: 0 };
    f.calls += r.calls;
    f.micro += r.micro;
    if (repair) f.repairMicro += r.micro;
    by.set(feature, f);
    total += r.micro;
  }
  return Array.from(by, ([feature, f]) => ({
    feature, calls: f.calls, micro: f.micro, repairMicro: f.repairMicro,
    repairShare: f.micro > 0 ? f.repairMicro / f.micro : 0,
    perCall: f.calls > 0 ? Math.round(f.micro / f.calls) : 0,
    shareOfTotal: total > 0 ? f.micro / total : 0,
  })).sort((a, b) => b.micro - a.micro);
}
