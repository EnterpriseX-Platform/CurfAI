/**
 * Release log shown at /admin/release-log. Hand-maintained — add one entry
 * per version bump (see the "chore: bump version to X.Y.Z" commits in git
 * history for exact scope + date). Newest first. Don't bump more than once
 * per calendar day — append to today's entry instead (see memory
 * one-version-bump-per-day).
 *
 * Each change is tagged with a category so the page can group them (New /
 * Improved / Fixed / Security) instead of one flat bullet list.
 *
 * `titleKey`/`textKey` point into src/lib/i18n/dict.ts (en/th/zh) — this
 * file only holds structure (version, date, category); the actual copy is
 * translated there so the page renders in the reader's locale.
 *
 * After editing this file or the en/ dict entries it points to, run
 * `npm run changelog:gen` to regenerate the repo-root CHANGELOG.md (an
 * English mirror for readers outside the app) from these same two files —
 * don't hand-edit CHANGELOG.md, it's generated and will just drift.
 */
export type ReleaseCategory = "feature" | "improvement" | "fix" | "security";

export type ReleaseChange = {
  category: ReleaseCategory;
  textKey: string;
};

export type ReleaseEntry = {
  version: string;
  date: string; // YYYY-MM-DD
  titleKey: string;
  changes: ReleaseChange[];
};

export const RELEASE_LOG: ReleaseEntry[] = [
  {
    version: "1.3.2",
    date: "2026-09-12",
    titleKey: "releaseLog.v1_3_2.title",
    changes: [
      { category: "security", textKey: "releaseLog.v1_3_2.c0" },
      { category: "security", textKey: "releaseLog.v1_3_2.c1" },
      { category: "fix", textKey: "releaseLog.v1_3_2.c2" },
      { category: "fix", textKey: "releaseLog.v1_3_2.c3" },
      { category: "fix", textKey: "releaseLog.v1_3_2.c4" },
    ],
  },
  {
    version: "1.3.1",
    date: "2026-09-11",
    titleKey: "releaseLog.v1_3_1.title",
    changes: [
      { category: "improvement", textKey: "releaseLog.v1_3_1.c3" },
      { category: "improvement", textKey: "releaseLog.v1_3_1.c4" },
      { category: "fix", textKey: "releaseLog.v1_3_1.c0" },
      { category: "fix", textKey: "releaseLog.v1_3_1.c1" },
      { category: "fix", textKey: "releaseLog.v1_3_1.c2" },
      { category: "fix", textKey: "releaseLog.v1_3_1.c5" },
      { category: "fix", textKey: "releaseLog.v1_3_1.c6" },
    ],
  },
  {
    version: "1.3.0",
    date: "2026-09-10",
    titleKey: "releaseLog.v1_3_0.title",
    changes: [
      { category: "feature", textKey: "releaseLog.v1_3_0.c0" },
      { category: "feature", textKey: "releaseLog.v1_3_0.c1" },
      { category: "feature", textKey: "releaseLog.v1_3_0.c2" },
      { category: "feature", textKey: "releaseLog.v1_3_0.c3" },
      { category: "improvement", textKey: "releaseLog.v1_3_0.c4" },
      { category: "improvement", textKey: "releaseLog.v1_3_0.c5" },
      { category: "fix", textKey: "releaseLog.v1_3_0.c6" },
      { category: "fix", textKey: "releaseLog.v1_3_0.c7" },
    ],
  },
  {
    version: "1.2.23",
    date: "2026-09-09",
    titleKey: "releaseLog.v1_2_23.title",
    changes: [
      { category: "feature", textKey: "releaseLog.v1_2_23.c0" },
      { category: "improvement", textKey: "releaseLog.v1_2_23.c1" },
      { category: "fix", textKey: "releaseLog.v1_2_23.c2" },
      { category: "fix", textKey: "releaseLog.v1_2_23.c3" },
      { category: "fix", textKey: "releaseLog.v1_2_23.c4" },
    ],
  },
  {
    version: "1.2.22",
    date: "2026-09-08",
    titleKey: "releaseLog.v1_2_22.title",
    changes: [
      { category: "fix", textKey: "releaseLog.v1_2_22.c0" },
      { category: "fix", textKey: "releaseLog.v1_2_22.c1" },
      { category: "improvement", textKey: "releaseLog.v1_2_22.c2" },
    ],
  },
  {
    version: "1.2.21",
    date: "2026-09-07",
    titleKey: "releaseLog.v1_2_21.title",
    changes: [
      { category: "fix", textKey: "releaseLog.v1_2_21.c0" },
      { category: "fix", textKey: "releaseLog.v1_2_21.c1" },
      { category: "fix", textKey: "releaseLog.v1_2_21.c2" },
      { category: "fix", textKey: "releaseLog.v1_2_21.c3" },
      { category: "feature", textKey: "releaseLog.v1_2_21.c4" },
      { category: "fix", textKey: "releaseLog.v1_2_21.c5" },
      { category: "improvement", textKey: "releaseLog.v1_2_21.c6" },
    ],
  },
  {
    version: "1.2.20",
    date: "2026-09-04",
    titleKey: "releaseLog.v1_2_20.title",
    changes: [
      { category: "feature", textKey: "releaseLog.v1_2_20.c0" },
      { category: "fix", textKey: "releaseLog.v1_2_20.c1" },
      { category: "fix", textKey: "releaseLog.v1_2_20.c2" },
      { category: "fix", textKey: "releaseLog.v1_2_20.c3" },
    ],
  },
  {
    version: "1.2.19",
    date: "2026-09-03",
    titleKey: "releaseLog.v1_2_19.title",
    changes: [
      { category: "fix", textKey: "releaseLog.v1_2_19.c0" },
      { category: "fix", textKey: "releaseLog.v1_2_19.c1" },
      { category: "fix", textKey: "releaseLog.v1_2_19.c2" },
      { category: "fix", textKey: "releaseLog.v1_2_19.c3" },
      { category: "fix", textKey: "releaseLog.v1_2_19.c4" },
      { category: "feature", textKey: "releaseLog.v1_2_19.c5" },
      { category: "fix", textKey: "releaseLog.v1_2_19.c6" },
      { category: "feature", textKey: "releaseLog.v1_2_19.c7" },
      { category: "fix", textKey: "releaseLog.v1_2_19.c8" },
      { category: "improvement", textKey: "releaseLog.v1_2_19.c9" },
    ],
  },
  {
    version: "1.2.18",
    date: "2026-08-31",
    titleKey: "releaseLog.v1_2_18.title",
    changes: [
      { category: "improvement", textKey: "releaseLog.v1_2_18.c0" },
      { category: "fix", textKey: "releaseLog.v1_2_18.c1" },
      { category: "fix", textKey: "releaseLog.v1_2_18.c2" },
      { category: "improvement", textKey: "releaseLog.v1_2_18.c3" },
      { category: "fix", textKey: "releaseLog.v1_2_18.c4" },
      { category: "fix", textKey: "releaseLog.v1_2_18.c5" },
      { category: "fix", textKey: "releaseLog.v1_2_18.c6" },
      { category: "feature", textKey: "releaseLog.v1_2_18.c7" },
      { category: "fix", textKey: "releaseLog.v1_2_18.c8" },
      { category: "feature", textKey: "releaseLog.v1_2_18.c9" },
      { category: "fix", textKey: "releaseLog.v1_2_18.c10" },
      { category: "fix", textKey: "releaseLog.v1_2_18.c11" },
      { category: "improvement", textKey: "releaseLog.v1_2_18.c12" },
    ],
  },
  {
    version: "1.2.17",
    date: "2026-08-31",
    titleKey: "releaseLog.v1_2_17.title",
    changes: [
      { category: "feature", textKey: "releaseLog.v1_2_17.c0" },
      { category: "fix", textKey: "releaseLog.v1_2_17.c1" },
      { category: "feature", textKey: "releaseLog.v1_2_17.c2" },
      { category: "fix", textKey: "releaseLog.v1_2_17.c3" },
      { category: "fix", textKey: "releaseLog.v1_2_17.c4" },
      { category: "fix", textKey: "releaseLog.v1_2_17.c5" },
      { category: "fix", textKey: "releaseLog.v1_2_17.c6" },
      { category: "improvement", textKey: "releaseLog.v1_2_17.c7" },
      { category: "improvement", textKey: "releaseLog.v1_2_17.c8" },
      { category: "feature", textKey: "releaseLog.v1_2_17.c9" },
    ],
  },
  {
    version: "1.2.16",
    date: "2026-08-28",
    titleKey: "releaseLog.v1_2_16.title",
    changes: [
      { category: "fix", textKey: "releaseLog.v1_2_16.c0" },
      { category: "fix", textKey: "releaseLog.v1_2_16.c1" },
      { category: "fix", textKey: "releaseLog.v1_2_16.c2" },
      { category: "improvement", textKey: "releaseLog.v1_2_16.c3" },
      { category: "improvement", textKey: "releaseLog.v1_2_16.c4" },
      { category: "feature", textKey: "releaseLog.v1_2_16.c5" },
      { category: "feature", textKey: "releaseLog.v1_2_16.c6" },
      { category: "feature", textKey: "releaseLog.v1_2_16.c7" },
      { category: "fix", textKey: "releaseLog.v1_2_16.c8" },
      { category: "fix", textKey: "releaseLog.v1_2_16.c9" },
      { category: "fix", textKey: "releaseLog.v1_2_16.c10" },
      { category: "fix", textKey: "releaseLog.v1_2_16.c11" },
      { category: "fix", textKey: "releaseLog.v1_2_16.c12" },
    ],
  },
  {
    version: "1.2.15",
    date: "2026-08-27",
    titleKey: "releaseLog.v1_2_15.title",
    changes: [
      { category: "security", textKey: "releaseLog.v1_2_15.c0" },
      { category: "feature", textKey: "releaseLog.v1_2_15.c1" },
      { category: "improvement", textKey: "releaseLog.v1_2_15.c2" },
      { category: "improvement", textKey: "releaseLog.v1_2_15.c3" },
      { category: "fix", textKey: "releaseLog.v1_2_15.c4" },
      { category: "feature", textKey: "releaseLog.v1_2_15.c5" },
    ],
  },
  {
    version: "1.2.14",
    date: "2026-08-26",
    titleKey: "releaseLog.v1_2_14.title",
    changes: [
      { category: "security", textKey: "releaseLog.v1_2_14.c0" },
      { category: "security", textKey: "releaseLog.v1_2_14.c1" },
      { category: "improvement", textKey: "releaseLog.v1_2_14.c2" },
      { category: "security", textKey: "releaseLog.v1_2_14.c3" },
      { category: "security", textKey: "releaseLog.v1_2_14.c4" },
      { category: "security", textKey: "releaseLog.v1_2_14.c5" },
      { category: "security", textKey: "releaseLog.v1_2_14.c6" },
      { category: "security", textKey: "releaseLog.v1_2_14.c7" },
      { category: "security", textKey: "releaseLog.v1_2_14.c8" },
      { category: "security", textKey: "releaseLog.v1_2_14.c9" },
      { category: "feature", textKey: "releaseLog.v1_2_14.c10" },
      { category: "improvement", textKey: "releaseLog.v1_2_14.c11" },
      { category: "fix", textKey: "releaseLog.v1_2_14.c12" },
      { category: "improvement", textKey: "releaseLog.v1_2_14.c13" },
    ],
  },
  {
    version: "1.2.13",
    date: "2026-08-25",
    titleKey: "releaseLog.v1_2_13.title",
    changes: [
      { category: "improvement", textKey: "releaseLog.v1_2_13.c0" },
      { category: "fix", textKey: "releaseLog.v1_2_13.c1" },
      { category: "security", textKey: "releaseLog.v1_2_13.c2" },
      { category: "security", textKey: "releaseLog.v1_2_13.c3" },
      { category: "improvement", textKey: "releaseLog.v1_2_13.c4" },
    ],
  },
  {
    version: "1.2.12",
    date: "2026-08-24",
    titleKey: "releaseLog.v1_2_12.title",
    changes: [
      { category: "improvement", textKey: "releaseLog.v1_2_12.c0" },
      { category: "fix", textKey: "releaseLog.v1_2_12.c1" },
      { category: "fix", textKey: "releaseLog.v1_2_12.c2" },
    ],
  },
  {
    version: "1.2.11",
    date: "2026-08-23",
    titleKey: "releaseLog.v1_2_11.title",
    changes: [
      { category: "security", textKey: "releaseLog.v1_2_11.c0" },
      { category: "fix", textKey: "releaseLog.v1_2_11.c1" },
      { category: "improvement", textKey: "releaseLog.v1_2_11.c2" },
      { category: "feature", textKey: "releaseLog.v1_2_11.c3" },
      { category: "feature", textKey: "releaseLog.v1_2_11.c4" },
      { category: "feature", textKey: "releaseLog.v1_2_11.c5" },
      { category: "fix", textKey: "releaseLog.v1_2_11.c6" },
      { category: "fix", textKey: "releaseLog.v1_2_11.c7" },
      { category: "feature", textKey: "releaseLog.v1_2_11.c8" },
      { category: "feature", textKey: "releaseLog.v1_2_11.c9" },
      { category: "fix", textKey: "releaseLog.v1_2_11.c10" },
      { category: "fix", textKey: "releaseLog.v1_2_11.c11" },
      { category: "feature", textKey: "releaseLog.v1_2_11.c12" },
      { category: "feature", textKey: "releaseLog.v1_2_11.c13" },
    ],
  },
  {
    version: "1.2.10",
    date: "2026-08-22",
    titleKey: "releaseLog.v1_2_10.title",
    changes: [
      { category: "feature", textKey: "releaseLog.v1_2_10.c0" },
      { category: "feature", textKey: "releaseLog.v1_2_10.c1" },
      { category: "security", textKey: "releaseLog.v1_2_10.c2" },
      { category: "security", textKey: "releaseLog.v1_2_10.c3" },
      { category: "security", textKey: "releaseLog.v1_2_10.c4" },
      { category: "fix", textKey: "releaseLog.v1_2_10.c5" },
      { category: "fix", textKey: "releaseLog.v1_2_10.c6" },
      { category: "fix", textKey: "releaseLog.v1_2_10.c7" },
      { category: "fix", textKey: "releaseLog.v1_2_10.c8" },
      { category: "security", textKey: "releaseLog.v1_2_10.c9" },
      { category: "feature", textKey: "releaseLog.v1_2_10.c10" },
      { category: "improvement", textKey: "releaseLog.v1_2_10.c11" },
      { category: "improvement", textKey: "releaseLog.v1_2_10.c12" },
      { category: "security", textKey: "releaseLog.v1_2_10.c13" },
      { category: "fix", textKey: "releaseLog.v1_2_10.c14" },
      { category: "security", textKey: "releaseLog.v1_2_10.c15" },
    ],
  },
  {
    version: "1.2.9",
    date: "2026-08-21",
    titleKey: "releaseLog.v1_2_9.title",
    changes: [
      { category: "feature", textKey: "releaseLog.v1_2_9.c0" },
      { category: "fix", textKey: "releaseLog.v1_2_9.c1" },
      { category: "fix", textKey: "releaseLog.v1_2_9.c2" },
      { category: "improvement", textKey: "releaseLog.v1_2_9.c3" },
      { category: "improvement", textKey: "releaseLog.v1_2_9.c4" },
      { category: "security", textKey: "releaseLog.v1_2_9.c5" },
      { category: "feature", textKey: "releaseLog.v1_2_9.c6" },
      { category: "improvement", textKey: "releaseLog.v1_2_9.c7" },
      { category: "fix", textKey: "releaseLog.v1_2_9.c8" },
    ],
  },
  {
    version: "1.2.8",
    date: "2026-08-19",
    titleKey: "releaseLog.v1_2_8.title",
    changes: [
      { category: "security", textKey: "releaseLog.v1_2_8.c0" },
      { category: "fix", textKey: "releaseLog.v1_2_8.c1" },
      { category: "improvement", textKey: "releaseLog.v1_2_8.c2" },
      { category: "improvement", textKey: "releaseLog.v1_2_8.c3" },
      { category: "fix", textKey: "releaseLog.v1_2_8.c4" },
      { category: "fix", textKey: "releaseLog.v1_2_8.c5" },
    ],
  },
  {
    version: "1.2.6",
    date: "2026-08-14",
    titleKey: "releaseLog.v1_2_6.title",
    changes: [
      { category: "feature", textKey: "releaseLog.v1_2_6.c0" },
      { category: "feature", textKey: "releaseLog.v1_2_6.c1" },
      { category: "feature", textKey: "releaseLog.v1_2_6.c2" },
      { category: "feature", textKey: "releaseLog.v1_2_6.c3" },
      { category: "feature", textKey: "releaseLog.v1_2_6.c4" },
      { category: "feature", textKey: "releaseLog.v1_2_6.c5" },
      { category: "security", textKey: "releaseLog.v1_2_6.c6" },
      { category: "fix", textKey: "releaseLog.v1_2_6.c7" },
      { category: "fix", textKey: "releaseLog.v1_2_6.c8" },
      { category: "improvement", textKey: "releaseLog.v1_2_6.c9" },
      { category: "improvement", textKey: "releaseLog.v1_2_6.c10" },
      { category: "fix", textKey: "releaseLog.v1_2_6.c11" },
      { category: "fix", textKey: "releaseLog.v1_2_6.c12" },
      { category: "security", textKey: "releaseLog.v1_2_6.c13" },
    ],
  },
  {
    version: "1.2.4",
    date: "2026-08-13",
    titleKey: "releaseLog.v1_2_4.title",
    changes: [
      { category: "feature", textKey: "releaseLog.v1_2_4.c0" },
      { category: "feature", textKey: "releaseLog.v1_2_4.c1" },
      { category: "feature", textKey: "releaseLog.v1_2_4.c2" },
      { category: "improvement", textKey: "releaseLog.v1_2_4.c3" },
      { category: "feature", textKey: "releaseLog.v1_2_4.c4" },
      { category: "feature", textKey: "releaseLog.v1_2_4.c5" },
      { category: "feature", textKey: "releaseLog.v1_2_4.c6" },
    ],
  },
  {
    version: "1.2.3",
    date: "2026-08-07",
    titleKey: "releaseLog.v1_2_3.title",
    changes: [
      { category: "improvement", textKey: "releaseLog.v1_2_3.c0" },
    ],
  },
  {
    version: "1.2.2",
    date: "2026-08-06",
    titleKey: "releaseLog.v1_2_2.title",
    changes: [
      { category: "feature", textKey: "releaseLog.v1_2_2.c0" },
      { category: "feature", textKey: "releaseLog.v1_2_2.c1" },
      { category: "feature", textKey: "releaseLog.v1_2_2.c2" },
    ],
  },
  {
    version: "1.2.1",
    date: "2026-08-05",
    titleKey: "releaseLog.v1_2_1.title",
    changes: [
      { category: "feature", textKey: "releaseLog.v1_2_1.c0" },
      { category: "improvement", textKey: "releaseLog.v1_2_1.c1" },
      { category: "fix", textKey: "releaseLog.v1_2_1.c2" },
      { category: "fix", textKey: "releaseLog.v1_2_1.c3" },
    ],
  },
];
