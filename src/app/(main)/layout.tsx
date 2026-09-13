import { ThemeModeBoot } from "@/components/layout/ThemeModeBoot";

export const dynamic = "force-dynamic";

/**
 * Route-group layout for the signed-in app. Its only job is to stamp the
 * user's light / dark mode on <html> before the page paints; pages keep
 * rendering their own AppShell.
 */
export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ThemeModeBoot />
      {children}
    </>
  );
}
