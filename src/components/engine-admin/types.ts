/** What every panel of the engine admin console is given: which engine data source it is working on. */
export type EngineAdminPanelProps = {
  /** The Curf data source of kind "engine". Every call to the engine goes through it (?dataSourceId=). */
  dataSourceId: string;
  /** Its name, for headings. */
  name: string;
};

export const ENGINE_ADMIN_TABS = ["status", "people", "views", "databases"] as const;
export type EngineAdminTab = (typeof ENGINE_ADMIN_TABS)[number];

export function isEngineAdminTab(value: unknown): value is EngineAdminTab {
  return typeof value === "string" && (ENGINE_ADMIN_TABS as readonly string[]).includes(value);
}
