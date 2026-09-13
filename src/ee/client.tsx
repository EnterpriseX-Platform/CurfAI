"use client";
/** Community edition: no paid client extensions. See src/lib/ee/clientTypes.ts. */
import type { EeClientRegistry } from "@/lib/ee/clientTypes";

import { EDITION } from "@/lib/ee/edition";

export const eeClient: EeClientRegistry = { edition: EDITION };
