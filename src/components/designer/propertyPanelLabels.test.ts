/**
 * The property panel builds its form from BlockConfigSchemas, so every field
 * name and enum value it can show needs a blockField.<name> /
 * blockOption.<value> entry, and every block type a blockType.<type> name, in
 * all three locales. Without this a new schema field silently renders its
 * humanized English key in Thai and Chinese.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { BlockConfigSchemas } from "@/lib/reporting/schema";
import { DICT, LOCALES } from "@/lib/i18n/dict";

function unwrap(field: z.ZodTypeAny): z.ZodTypeAny {
  let f = field;
  while (f instanceof z.ZodOptional || f instanceof z.ZodDefault || f instanceof z.ZodNullable) {
    f = (f as any)._def.innerType ?? (f as any)._def.schema;
  }
  return f;
}

// Fields whose options come from a bespoke picker rather than the generic enum Select.
const BESPOKE_ENUMS = new Set(["chartType"]);

const needed = new Set<string>();
for (const [type, schema] of Object.entries(BlockConfigSchemas)) {
  needed.add(`blockType.${type}`);
  for (const [name, field] of Object.entries((schema as z.ZodObject<any>).shape ?? {})) {
    needed.add(`blockField.${name}`);
    const inner = unwrap(field as z.ZodTypeAny);
    if (inner instanceof z.ZodEnum && !BESPOKE_ENUMS.has(name)) {
      for (const o of inner.options as string[]) needed.add(`blockOption.${o}`);
    }
  }
}

describe("property panel labels", () => {
  for (const locale of LOCALES) {
    it(`every block type, config field and option value has a ${locale} label`, () => {
      expect([...needed].filter((k) => !DICT[locale][k])).toEqual([]);
    });
  }
});
