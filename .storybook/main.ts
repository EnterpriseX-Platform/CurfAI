// Storybook config — Curf (Harness 8: visual regression).
//
// Stories live alongside the components in src/components/blocks/* and
// src/components/designer/*. We deliberately scope the glob narrowly so
// adding a story for a non-block / non-designer component doesn't pull
// it into the visual-regression set without an explicit policy decision.
//
// All 18 block kinds have stories now (KpiBlock, ChartBlock incl. its
// gauge/waterfall/bullet chartTypes, + the remaining 13 block components).
// Designer-surface stories (drag/resize/canvas chrome) are still open.

import path from "path";
import type { StorybookConfig } from "@storybook/react-webpack5";

const config: StorybookConfig = {
  stories: [
    "../src/components/blocks/**/*.stories.tsx",
    "../src/components/designer/**/*.stories.tsx",
  ],
  // addon-webpack5-compiler-swc is required with @storybook/react-webpack5 —
  // unlike @storybook/nextjs (which reused Next's own SWC pipeline), the
  // plain webpack5 builder ships no TS/JSX transpiler of its own; without
  // this, every .stories.tsx fails to parse ("Unexpected token" on the
  // first `import type`).
  addons: ["@storybook/addon-essentials", "@storybook/addon-webpack5-compiler-swc"],
  // Plain React webpack5, NOT @storybook/nextjs — the Next-aware framework
  // routes compilation through Next 14's bundled webpack, which isn't
  // hook-compatible with @storybook/builder-webpack5's own webpack and
  // throws at every build's Compiler.close() (SB_BUILDER-WEBPACK5_0002,
  // "Cannot read properties of undefined (reading 'tap')") — reproduces
  // even with zero custom stories, so it's a framework/Next version-pairing
  // bug, not anything fixable from story content. None of the block
  // components use Next-specific features (next/image, next/link,
  // next/navigation) — they're plain presentational components reading
  // props — so the Next-aware webpack wiring buys nothing here anyway.
  framework: { name: "@storybook/react-webpack5", options: {} },
  // @storybook/nextjs auto-applied tsconfig.json's "@/*" -> "./src/*" path
  // alias (via Next's own webpack config); plain react-webpack5 doesn't
  // read tsconfig paths for module resolution at all (only for react-docgen
  // prop tables), so every "@/..." import across the app's shared libs
  // (lib/reporting/themes, components/providers/*, etc.) 404s without this.
  webpackFinal: (webpackConfig) => {
    webpackConfig.resolve = webpackConfig.resolve ?? {};
    webpackConfig.resolve.alias = {
      ...webpackConfig.resolve.alias,
      "@": path.resolve(__dirname, "../src"),
      // See mocks/nextNavigationMock.ts — LocaleProvider (wrapped around
      // every story below) calls useRouter(), which needs a real Next.js
      // App Router mount that plain react-webpack5 never provides.
      "next/navigation": path.resolve(__dirname, "./mocks/nextNavigationMock.ts"),
    };

    // @storybook/nextjs ran globals.css through Next's own PostCSS+Tailwind
    // pipeline; @storybook/builder-webpack5's "implicit CSS loaders" are
    // just css-loader+style-loader with NO postcss-loader, so every
    // "@tailwind base/components/utilities" directive passed through
    // completely literally. Every Tailwind utility class in every block
    // component (h-full, flex, flex-col, gap-*, bg-card, ...) silently did
    // nothing — components fell back to browser default `display: block`.
    // Table/Pivot/Cohort happened to still look plausible (plain tables
    // and bordered divs read fine even as block-level default flow), but
    // anything actually depending on flexbox to size itself — ChartBlock
    // and MapBlock's `h-full flex flex-col` -> recharts/d3 sizing its SVG
    // off the measured container height — rendered as a blank 0-height
    // box. Confirmed via getComputedStyle in a live story: the "h-full
    // flex-col" wrapper measured `display: block`, height collapsed to
    // its content (a header), and recharts' ResponsiveContainer measured
    // 0 height and never drew anything.
    const rules = webpackConfig.module?.rules ?? [];
    for (const rule of rules) {
      if (
        rule &&
        typeof rule === "object" &&
        "test" in rule &&
        rule.test instanceof RegExp &&
        rule.test.test("x.css") &&
        Array.isArray(rule.use)
      ) {
        rule.use = [...rule.use, { loader: require.resolve("postcss-loader") }];
      }
    }
    return webpackConfig;
  },
};

export default config;
