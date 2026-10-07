import { describe, expect, it } from "vitest";
import { DICT, LOCALES } from "@/lib/i18n/dict";
import { queryNotRun } from "@/lib/reporting/queryRunState";
import type { ProvenanceRecord } from "@/lib/reporting/provenance";
import { ENGINE_REASON, localizeEngineReason } from "./reasons";

const record = (executionError?: string, accessDeniedNote?: string) => ({ executionError, accessDeniedNote }) as ProvenanceRecord;
const tIn = (locale: "en" | "th" | "zh") => (key: string) => (DICT[locale] as Record<string, string>)[key] ?? `?${key}`;

describe("engine reasons", () => {
  it("has a translation in every language for every sentence the engine client can report", () => {
    for (const locale of LOCALES) {
      for (const r of Object.values(ENGINE_REASON)) {
        const text = (DICT[locale] as Record<string, string>)[r.key];
        expect(text, `${r.key} in ${locale}`).toBeTruthy();
      }
    }
  });

  it("shows a known sentence in the reader's language and keeps the stored English untouched", () => {
    const stored = ENGINE_REASON.viewNotAvailable.text;
    expect(localizeEngineReason(stored, tIn("th"))).toBe((DICT.th as Record<string, string>)["engineReason.notAvailable"]);
    expect(localizeEngineReason(stored, tIn("th"))).not.toBe(stored);
    expect(stored).toMatch(/does not exist on the engine/);
  });

  it("leaves any other reason, such as a database's error text, exactly as reported", () => {
    expect(localizeEngineReason("Binder Error: no such column", tIn("th"))).toBe("Binder Error: no such column");
  });

  it("maps both wordings of the same answer to one key", () => {
    expect(ENGINE_REASON.notAvailable.key).toBe(ENGINE_REASON.viewNotAvailable.key);
    expect(ENGINE_REASON.forbidden.key).toBe(ENGINE_REASON.forbiddenQuery.key);
  });

  it("queryNotRun translates only when given t, and keeps the kind", () => {
    const rec = record(ENGINE_REASON.viewNotAvailable.text);
    expect(queryNotRun(rec)?.reason).toBe(ENGINE_REASON.viewNotAvailable.text);
    const localized = queryNotRun(rec, tIn("zh"));
    expect(localized?.kind).toBe("failed");
    expect(localized?.reason).toBe((DICT.zh as Record<string, string>)["engineReason.notAvailable"]);
    expect(queryNotRun(record(undefined, "hidden"), tIn("th"))).toEqual({ kind: "restricted", reason: "hidden" });
    expect(queryNotRun(record(), tIn("th"))).toBeUndefined();
  });
});
