/**
 * The throwaway accounts /api/try hands to anonymous visitors of the demo workspace: `try-<12 hex>@curf.demo`, a viewer in the
 * seeded "demo" workspace, with a random password the visitor never sees. They are the one thing that still signs in with a
 * password when Keycloak is the only sign-in (a visitor has no identity to put in Keycloak), and only these: any other address
 * is refused a password sign-in outright (lib/auth.ts).
 */
export const DEMO_EMAIL_PATTERN = /^try-[0-9a-f]{12}@curf\.demo$/;

export function isDemoAccountEmail(email: string | null | undefined): boolean {
  return !!email && DEMO_EMAIL_PATTERN.test(email.trim().toLowerCase());
}
