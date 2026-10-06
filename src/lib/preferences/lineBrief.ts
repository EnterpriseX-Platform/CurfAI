/**
 * User.preferencesJson.lineBrief — the morning brief on LINE (lib/line/brief.ts,
 * executive journey P4b). Its own module so /api/user/preferences can
 * validate it without reaching the LINE code, which the Community edition
 * doesn't ship.
 */
import { z } from "zod";

export const validTz = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

export const LineBriefSchema = z.object({
  on: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  tz: z.string().max(64).refine(validTz, "Unknown time zone"),
});
export type LineBriefPrefs = z.infer<typeof LineBriefSchema>;
