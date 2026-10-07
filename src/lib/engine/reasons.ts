/**
 * The fixed sentences the engine client reports when a query does not run, and the dictionary key each one
 * is shown under. A failed query keeps its reason in provenance as a plain string, which a block shows as
 * it is; for these known answers a reader — often an anonymous one on a public link — should get their own
 * language instead. The English text stays what is stored and what an API caller gets.
 *
 * Pure and dependency-free: `client.ts` (server) takes its wording from here, and the blocks (client) use
 * `localizeEngineReason`, so the two cannot drift apart.
 */
type Reason = { text: string; key: string };
const reason = (key: string, text: string): Reason => ({ key: `engineReason.${key}`, text });

export const ENGINE_REASON = {
  identity: reason("identity", "The engine did not accept Curf's identity token (check its issuer and key settings)."),
  forbidden: reason("forbidden", "The engine does not allow this person to do that."),
  forbiddenQuery: reason("forbidden", "The engine does not allow this person to run queries."),
  notAvailable: reason("notAvailable", "That does not exist on the engine, is not published, or is not available to you."),
  viewNotAvailable: reason("notAvailable", "That view does not exist on the engine, is not published, or is not available to you."),
  busy: reason("busy", "The engine is busy with your other queries. Try again in a moment."),
  notReady: reason("notReady", "The engine is not ready to answer."),
  timeLimit: reason("timeLimit", "The query ran past the engine's time limit and was cancelled."),
  noAnswer: reason("timeLimit", "The engine did not answer in time."),
  unreachable: reason("unreachable", "The engine could not be reached."),
  redirect: reason("redirect", "The engine answered with a redirect, which is not followed."),
} as const;

const KEY_OF_TEXT: Map<string, string> = new Map(Object.values(ENGINE_REASON).map((r) => [r.text, r.key]));

/** `reason` in the reader's language when it is one of the engine's fixed sentences; otherwise exactly as given. */
export function localizeEngineReason(reasonText: string, t: (key: string) => string): string {
  const key = KEY_OF_TEXT.get(reasonText);
  return key ? t(key) : reasonText;
}
