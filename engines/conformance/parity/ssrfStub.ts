// Used only by this check. The hosted edition refuses private addresses, and the test database is on this machine.
export * from "../../../src/lib/security/ssrfGuard";
export async function assertPublicHost(_hostname: string): Promise<void> {}
