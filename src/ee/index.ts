/**
 * Community edition: no paid extensions. Every optional member of the
 * registry is absent, and every Community call site treats that as
 * "not in this edition". See src/lib/ee/types.ts.
 */
import type { EeRegistry } from "@/lib/ee/types";

import { EDITION } from "@/lib/ee/edition";

export const ee: EeRegistry = { edition: EDITION };
