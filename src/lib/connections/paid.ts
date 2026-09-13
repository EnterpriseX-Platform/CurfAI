/**
 * Lookup for connector kinds that live in the paid edition (Snowflake,
 * BigQuery, SFTP). The data-source routes validate every kind's payload
 * themselves — the Zod schemas are cheap and edition-independent — and
 * reach here only for the parts that need the driver: credential encoding,
 * masking, and the connection test.
 */
import { NextResponse } from "next/server";
import { ee } from "@/ee";
import type { WarehouseConnector } from "@/lib/ee/types";

export type PaidConnectorApi = Pick<WarehouseConnector, "encode" | "encodeUpdate" | "mask" | "test">;

export function paidConnector(kind: string): PaidConnectorApi | null {
  if (kind === "sftp") return ee.connectors?.sftp ?? null;
  return ee.connectors?.warehouses[kind] ?? null;
}

export function unsupportedKindResponse(kind: string): NextResponse {
  return NextResponse.json(
    { error: `The ${kind} connector is not available in this edition.`, kind },
    { status: 400 },
  );
}
