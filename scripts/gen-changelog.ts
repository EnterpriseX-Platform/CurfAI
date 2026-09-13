/**
 * One-off generator: renders CHANGELOG.md from the app's own release log
 * (src/lib/releaseLog.ts structure + English copy from src/lib/i18n/dict.ts)
 * so the two never drift. Re-run after editing either source:
 *   npx tsx scripts/gen-changelog.ts
 */
import { mkdirSync, writeFileSync } from "fs";
import { RELEASE_LOG } from "../src/lib/releaseLog";
import { DICT } from "../src/lib/i18n/dict";

const CATEGORY_ORDER = ["feature", "improvement", "fix", "security"] as const;
const CATEGORY_LABEL: Record<string, string> = {
  feature: "New",
  improvement: "Improved",
  fix: "Fixed",
  security: "Security",
};

const en = DICT.en as Record<string, string>;

// The release copy itself often already opens with "Fixed:" / "New:" (it's
// shared with the in-app page, which shows the same word again as a
// category chip above the group) — stripping a matching leading word here
// avoids "**Fixed:** Fixed: ..." when this file adds its own bold label.
function stripRedundantLeadIn(text: string, category: string): string {
  const label = CATEGORY_LABEL[category];
  if (!label) return text;
  const re = new RegExp(`^${label}:\\s*`, "i");
  const stripped = text.replace(re, "");
  if (stripped === text) return text;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

let out = "# Changelog\n\n";
out += "All notable changes to CurfAI. The in-app version (with Thai and Chinese translations) lives at `/admin/release-log`; this file mirrors it in English, generated from the same source — see `scripts/gen-changelog.ts`.\n\n";

for (const entry of RELEASE_LOG) {
  const title = en[entry.titleKey] ?? entry.titleKey;
  out += `## [${entry.version}] — ${entry.date}\n\n`;
  out += `${title}\n\n`;
  for (const category of CATEGORY_ORDER) {
    const items = entry.changes.filter((c) => c.category === category);
    if (!items.length) continue;
    out += `**${CATEGORY_LABEL[category]}**\n`;
    for (const change of items) {
      const text = stripRedundantLeadIn(en[change.textKey] ?? change.textKey, change.category);
      out += `- ${text}\n`;
    }
    out += "\n";
  }
}

writeFileSync(new URL("../CHANGELOG.md", import.meta.url), out);
console.log(`Wrote CHANGELOG.md (${RELEASE_LOG.length} versions).`);

// The marketing site's /changelog page (marketing/src/pages/changelog.astro)
// renders this JSON at build time — same source, so curf.ai never drifts
// from the in-app release log either.
const marketing = {
  generatedAt: new Date().toISOString().slice(0, 10),
  entries: RELEASE_LOG.map((entry) => ({
    version: entry.version,
    date: entry.date,
    title: en[entry.titleKey] ?? entry.titleKey,
    changes: entry.changes.map((change) => ({
      category: change.category,
      text: stripRedundantLeadIn(en[change.textKey] ?? change.textKey, change.category),
    })),
  })),
};
const marketingOut = new URL("../marketing/src/data/changelog.json", import.meta.url);
mkdirSync(new URL("./", marketingOut), { recursive: true });
writeFileSync(marketingOut, JSON.stringify(marketing, null, 2) + "\n");
console.log(`Wrote marketing/src/data/changelog.json (${marketing.entries.length} versions).`);
