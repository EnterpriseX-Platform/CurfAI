import { EDITION } from "@/lib/ee/edition";
import { assertPublicHost } from "@/lib/security/ssrfGuard";

/**
 * Whether a workspace may connect a Postgres/MySQL source to `host`.
 *
 * On the hosted (cloud) edition every workspace shares one network, so a
 * host that is — or resolves to — a private/reserved address would reach
 * Curf's own internal services (its database, the cluster) rather than the
 * customer's warehouse. It is refused, the way SFTP hosts already are
 * (lib/connections/sftp.ts). A self-hosted Community install connects to
 * warehouses on its own private network by design, so the check is off there.
 */
export async function assertWarehouseHost(host: string): Promise<void> {
  if (EDITION === "community") return;
  await assertPublicHost(host);
}
