import { cookies } from "next/headers";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { ScreenPairForm } from "./ScreenPairForm";

export const dynamic = "force-dynamic";

async function readLocale(): Promise<Locale> {
  const v = (await cookies()).get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

/**
 * Open this on a wall screen, type the code an admin read out from
 * On Screen, and the screen goes to its display. No sign-in: the code is the
 * credential (POST /api/screen/pair).
 */
export default async function ScreenPage() {
  const locale = await readLocale();
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4">
      <ScreenPairForm
        labels={{
          title: t(locale, "screenPair.title"),
          hint: t(locale, "screenPair.hint"),
          connect: t(locale, "screenPair.connect"),
          connecting: t(locale, "screenPair.connecting"),
          invalid: t(locale, "screenPair.invalid"),
          tooMany: t(locale, "screenPair.tooMany"),
        }}
      />
    </main>
  );
}
