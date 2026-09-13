import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseThemeMode, themeModeBootScript, type ThemeMode } from "@/lib/themeMode";

/**
 * Stamps the signed-in user's light / dark mode on <html> before first paint.
 *
 * Rendered at the top of the app's route-group layouts, so the inline
 * script runs as soon as the body starts parsing — ahead of the page's
 * own markup and of React hydration. Anonymous visitors get "auto", which
 * stamps nothing and lets the OS decide (see lib/themeMode.ts).
 */
export async function ThemeModeBoot() {
  const mode = await loadThemeMode();
  return <script dangerouslySetInnerHTML={{ __html: themeModeBootScript(mode) }} />;
}

async function loadThemeMode(): Promise<ThemeMode> {
  const session = await getSession();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return "auto";
  // The user's own row, by the id the session vouches for — the same read
  // /api/user/preferences does.
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { preferencesJson: true } as any });
  return parseThemeMode((row as { preferencesJson?: string | null } | null)?.preferencesJson);
}
