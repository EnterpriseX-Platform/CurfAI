import { prisma } from "@/lib/db";
import { LOCALES, type Locale } from "./dict";
import type { Era } from "./formatDate";

/**
 * A signed-in user's saved language (User.preferencesJson.locale), used when
 * the browser has no rd_locale cookie yet — a new device, a cleared browser,
 * the first sign-in after SSO. The cookie stays the per-request source of
 * truth; this only seeds it. User rows carry no tenantId, so no workspace
 * filter applies.
 */
export async function savedLocale(userId: string): Promise<Locale | undefined> {
  return (await savedDatePrefs(userId)).locale;
}

/** Saved language and, for Thai readers, Buddhist-era vs Gregorian years (lib/i18n/formatDate.ts). */
export async function savedDatePrefs(userId: string): Promise<{ locale?: Locale; era?: Era }> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { preferencesJson: true } as any });
  let prefs: any = {};
  try { prefs = JSON.parse((row as any)?.preferencesJson || "{}"); } catch { /* ignore */ }
  return {
    locale: (LOCALES as readonly string[]).includes(prefs?.locale) ? (prefs.locale as Locale) : undefined,
    era: prefs?.era === "ce" || prefs?.era === "be" ? prefs.era : undefined,
  };
}
