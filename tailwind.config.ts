import type { Config } from "tailwindcss";

const config: Config = {
  // `dark:` variants follow the same two doors as the tokens in globals.css:
  // the OS preference (unless <html> carries .light) or an explicit .dark.
  darkMode: ["variant", [
    "@media (prefers-color-scheme: dark) { &:not(.light *) }",
    "&:is(.dark *)",
  ]],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      fontFamily: {
        // Instrument Sans carries UI and display alike (display weight is
        // the component's job, e.g. KPI values at 600). It has no Thai
        // glyphs, so Thai text falls through to Prompt — same as before.
        sans: [
          "var(--font-sans)",
          "Instrument Sans",
          "var(--font-prompt)",
          "Prompt",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        // `font-display` is kept as an alias of `sans` so existing opt-ins
        // (KPI values) keep working; there is no longer a second family.
        display: [
          "var(--font-sans)",
          "Instrument Sans",
          "var(--font-prompt)",
          "Prompt",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        // IBM Plex Mono for provenance: hashes, run times, row counts, IDs.
        mono: [
          "var(--font-mono)",
          "IBM Plex Mono",
          "var(--font-prompt)",
          "Prompt",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        // Third ink weight, below muted-foreground: receipts, captions, kbd.
        faint: "hsl(var(--faint))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          // Hover / pressed state — a darker ink, not an opacity fade.
          ink: "hsl(var(--primary-ink))",
          // Tint for selected rows, active chips, soft highlights.
          soft: "hsl(var(--primary-soft))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          border: "hsl(var(--sidebar-border))",
          foreground: "hsl(var(--sidebar-foreground))",
          muted: "hsl(var(--sidebar-muted))",
        },
      },
      // Explicit 4 / 8 / 12 / 20 scale (tokens in globals.css). `md` and `lg`
      // both resolve to 8px on purpose: buttons, inputs, menu items and the
      // many small `rounded-lg` icon chips share one control radius; cards
      // and panels use `xl` (12), sheets and hero surfaces `2xl` (20).
      // `report` (block cards inside ReportDocument) sits with cards at 12.
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius)",
        lg: "var(--radius)",
        xl: "var(--radius-lg)",
        "2xl": "var(--radius-xl)",
        report: "var(--radius-report)",
      },
      // `xs` and `sm` both map to the token so the ui primitives (which use
      // shadow-sm) and the block surfaces (shadow-xs) share one value.
      // Tailwind's xl/2xl stay stock: overlays compose them with colour
      // modifiers (shadow-black/20) that only work on parseable defaults.
      boxShadow: {
        xs: "var(--shadow-sm)",
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 200ms ease-out",
        "accordion-up": "accordion-up 200ms ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
