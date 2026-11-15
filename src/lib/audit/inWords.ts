/**
 * An audit event's kind ("report.create", "datasource.delete") said as a short phrase, for the audit page. A kind is
 * "<family>.<action>"; the phrase is built from a verb and a thing, each translated by the caller, so the page never shows
 * English it has no word for: a kind whose family or action is not in these lists returns null and the page keeps the raw
 * kind as it always did. Pure and client-safe (it returns dictionary keys, never text).
 */
const FAMILIES: Record<string, string> = {
  lake: "lake", app: "app", operate: "operate", report: "report", marketplace: "marketplace", tenant: "tenant",
  strategist: "strategist", user: "user", billing: "billing", watcher: "watcher", datasource: "datasource",
  agent_brief: "agent_brief", webhook: "webhook", schedule: "schedule", notebook: "notebook", dashboard: "dashboard",
  role: "role", metric: "metric", document: "document", decision: "decision", master_builder: "master_builder",
};
const VERBS = new Set(["create", "created", "update", "updated", "delete", "deleted", "run", "revoke", "invite", "grant", "remove", "sync", "send", "approve", "import", "publish", "published", "refresh"]);
const SYNONYM: Record<string, string> = { created: "create", updated: "update", deleted: "delete", published: "publish" };

export type AuditWords = { verb: string; family: string };

/** Dictionary keys for the verb and the thing, or null when the kind is not one we have words for. */
export function auditInWords(kind: string): AuditWords | null {
  const parts = kind.split(".");
  if (parts.length < 2) return null;
  const family = FAMILIES[parts[0]];
  const action = parts[parts.length - 1];
  if (!family || !VERBS.has(action)) return null;
  return { verb: `auditWords.verb.${SYNONYM[action] ?? action}`, family: `auditWords.family.${family}` };
}

export const AUDIT_WORD_VERBS = Array.from(new Set(Array.from(VERBS).map((v) => SYNONYM[v] ?? v)));
export const AUDIT_WORD_FAMILIES = Array.from(new Set(Object.values(FAMILIES)));
