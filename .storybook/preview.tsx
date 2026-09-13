// Storybook global preview — Curf.
//
// Wraps every story in the same theme + style providers we use in the
// real app. We import the project's globals.css so Tailwind utility
// classes resolve and the design tokens (CSS variables) load.
//
// `themes` parameter exposes a Storybook toolbar control for switching
// theme so each story can be snapshotted across all built-in presets
// without authoring per-theme variants by hand.

import type { Preview } from "@storybook/react";
import React from "react";
import { ThemeProvider } from "../src/components/providers/ThemeProvider";
import { LocaleProvider } from "../src/lib/i18n/LocaleContext";
import { ToastHost } from "../src/lib/toast";
import "../src/app/globals.css";

const THEMES = ["default", "dark", "midnight", "sunrise", "sage"] as const;

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    backgrounds: {
      default: "light",
      values: [
        { name: "light", value: "#F6F7FB" },
        { name: "dark", value: "#0D0F16" },
      ],
    },
    viewport: {
      viewports: {
        mobile: { name: "Mobile", styles: { width: "375px", height: "667px" } },
        tablet: { name: "Tablet", styles: { width: "768px", height: "1024px" } },
        desktop: { name: "Desktop", styles: { width: "1280px", height: "800px" } },
      },
    },
  },
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Curf theme preset",
      defaultValue: "default",
      toolbar: {
        icon: "paintbrush",
        items: THEMES.map((t) => ({ value: t, title: t })),
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, ctx) => {
      const theme = (ctx.globals.theme as string) ?? "default";
      return (
        // LocaleProvider — several block components call useT() (e.g.
        // ChartBlock's ForecastControl), which throws outside a provider.
        // "en" keeps existing story snapshots unchanged.
        // ToastHost — the KPI card's Why? button (AskWhyButton) reports
        // failures through useToast(), which throws outside the host.
        <LocaleProvider initialLocale="en">
          <ToastHost>
            <ThemeProvider reportTheme={theme}>
              <div className="bg-background text-foreground p-6">
                <Story />
              </div>
            </ThemeProvider>
          </ToastHost>
        </LocaleProvider>
      );
    },
  ],
};

export default preview;
