/**
 * Passwords for the accounts the seeds create.
 *
 * In development every seeded account signs in with `admin123` (the
 * quickstart in README/CLAUDE.md). In production the seed used to do the
 * same — and, worse, reset an existing account back to it on every run, so
 * the cluster's seed job kept `admin@curf.local` / `admin123` a valid
 * production login (DEPLOY-NOTES.md, gap analysis P0-2). Now, when
 * NODE_ENV=production (the Docker image sets it):
 *   - a NEW seeded account gets CURF_SEED_ADMIN_PASSWORD (at least 16
 *     characters), and the seed refuses to run without it;
 *   - an EXISTING account's password is never touched.
 */
import bcrypt from "bcryptjs";

const DEV_PASSWORD = "admin123";

export function isProductionSeed(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The bcrypt hash a newly seeded account gets. Throws in production without a strong CURF_SEED_ADMIN_PASSWORD. */
export async function seedPasswordHash(): Promise<string> {
  if (!isProductionSeed()) return bcrypt.hash(DEV_PASSWORD, 10);
  const pw = process.env.CURF_SEED_ADMIN_PASSWORD ?? "";
  if (pw.length < 16 || pw === DEV_PASSWORD) {
    throw new Error(
      "Refusing to seed accounts in production without CURF_SEED_ADMIN_PASSWORD (at least 16 characters). " +
      "Existing accounts keep their passwords; only new seeded accounts get this one.",
    );
  }
  return bcrypt.hash(pw, 12);
}

/** The `update` half of a seeded user's upsert: dev resets the password, production never does. */
export function seedPasswordUpdate(passwordHash: string): { passwordHash?: string } {
  return isProductionSeed() ? {} : { passwordHash };
}

/** How the seed's closing summary describes the login. */
export function seedLoginHint(email: string): string {
  return isProductionSeed()
    ? `${email} (new accounts: CURF_SEED_ADMIN_PASSWORD; existing accounts unchanged)`
    : `${email} / ${DEV_PASSWORD}`;
}
