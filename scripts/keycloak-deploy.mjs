// The Keycloak realm step of a deploy, as one command (k8s/keycloak/config-job.yaml; docs/KEYCLOAK_IDENTITY.md "Deploying the realm").
//
//   node scripts/keycloak-deploy.mjs --context kt1-qa-admin                       look: checks what it would need, changes nothing
//   node scripts/keycloak-deploy.mjs --context kt1-qa-admin --apply               refresh the ConfigMap, run the config Job, run the check
//   node scripts/keycloak-deploy.mjs --context kt1-qa-admin --apply --bootstrap   the first time (and after rotating its secret): also
//                                                                                 create the config Job's own client, as the bootstrap admin
//   ... --apply --network-policy                                                  also apply k8s/keycloak/networkpolicy.yaml
//   node scripts/keycloak-deploy.mjs --context kt1-qa-admin --apply --configmap-only  only the ConfigMap: before Keycloak exists, because
//                                                                                 keycloak.yaml mounts it for the first import
//
// Every kubectl call names the context explicitly (the shell's current context is never used), and a context whose name contains "prod"
// is refused unless it is repeated in --confirm-context. It never reads a Secret's values: it only asks which keys the Secret has.
// Run it from the repository root, after the new Keycloak (keycloak.yaml) is rolled out and ready. Exit 0 = the realm is as the file says
// and the check passed; anything else prints why.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NAMESPACE = "curfai";
export const SECRET = "curfai-secrets";
export const CONFIGMAP = "curfai-keycloak-realm";
export const CONFIG_JOB = "curfai-keycloak-config";
export const BOOTSTRAP_JOB = "curfai-keycloak-config-bootstrap";
export const VERIFY_JOB = "curfai-keycloak-verify";

/** The files the Jobs read, by the name they have inside the ConfigMap. */
export const CONFIGMAP_FILES = {
  "curf.json": "k8s/keycloak/realm/curf.json",
  "render-realm.mjs": "k8s/keycloak/render-realm.mjs",
  "keycloak-config-client.mjs": "scripts/keycloak-config-client.mjs",
  "keycloak-realm-verify.mjs": "scripts/keycloak-realm-verify.mjs",
};

export function parseArgs(argv) {
  const out = { context: "", apply: false, bootstrap: false, networkPolicy: false, configmapOnly: false, confirmContext: "", help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i] ?? "";
    if (a === "--context") out.context = val();
    else if (a.startsWith("--context=")) out.context = a.slice(10);
    else if (a === "--apply") out.apply = true;
    else if (a === "--bootstrap") out.bootstrap = true;
    else if (a === "--network-policy") out.networkPolicy = true;
    else if (a === "--configmap-only") out.configmapOnly = true;
    else if (a === "--confirm-context") out.confirmContext = val();
    else if (a.startsWith("--confirm-context=")) out.confirmContext = a.slice(18);
    else if (a === "--help" || a === "-h") out.help = true;
    else out.unknown.push(a);
  }
  return out;
}

/** Why this run must not go ahead, or null. */
export function argProblem(a) {
  if (a.unknown.length) return `unknown option ${a.unknown[0]}`;
  if (!a.context) return "name the cluster with --context <kube context> (the shell's current context is never used)";
  if (/prod/i.test(a.context) && a.confirmContext !== a.context) return `"${a.context}" looks like production: repeat it as --confirm-context ${a.context} to go on`;
  if (a.bootstrap && !a.apply) return "--bootstrap changes things: add --apply";
  if (a.networkPolicy && !a.apply) return "--network-policy changes things: add --apply";
  if (a.configmapOnly && (!a.apply || a.bootstrap || a.networkPolicy)) return "--configmap-only is used alone, with --apply";
  return null;
}

/** The Secret keys the steps need (names only; the values are never read). */
export function requiredSecretKeys({ bootstrap }) {
  const keys = ["NEXTAUTH_URL", "CURF_KEYCLOAK_CLIENT_SECRET", "CURF_KEYCLOAK_ADMIN_CLIENT_SECRET", "CURF_KEYCLOAK_CONFIG_CLIENT_SECRET"];
  if (bootstrap) keys.push("KEYCLOAK_ADMIN_PASSWORD");
  return keys;
}
export const missingKeys = (have, need) => need.filter((k) => !have.includes(k));

/** A Job's log without the Java stack frames (the cause is in the lines above them). */
export const cleanLog = (s) => String(s ?? "").split("\n").filter((l) => !/^(\[[^\]]*\] )?\s*(at |\.\.\. \d+ more)/.test(l)).join("\n").trim();

/** What a failed Job's log most likely means, in words for whoever is deploying; null when it isn't recognised. */
export function explainFailure(log) {
  if (/HTTP 401|invalid_client|Invalid client or Invalid client credentials/i.test(log)) {
    return `Keycloak refused the config client's credentials: CURF_KEYCLOAK_CONFIG_CLIENT_SECRET in ${SECRET} doesn't match the client (or the client doesn't exist yet). Run with --bootstrap: it creates the client and sets its secret from the Secret.`;
  }
  if (/CURF_KEYCLOAK_CONFIG_CLIENT_SECRET must be at least/.test(log)) return "CURF_KEYCLOAK_CONFIG_CLIENT_SECRET is too short: use `openssl rand -hex 32`.";
  if (/sign-in to Keycloak failed \(401\)/.test(log)) return "The bootstrap admin was refused: KEYCLOAK_ADMIN_PASSWORD in the Secret isn't the admin's current password.";
  if (/realm file needs/.test(log)) return "A value the realm file needs is missing from the Secret (named above).";
  if (/Could not connect to keycloak/i.test(log)) return "Keycloak couldn't be reached from the Job: is the curfai-keycloak Service up, and does a NetworkPolicy block the Job?";
  return null;
}

// ── kubectl ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function kubectl(ctx, args, { input, quiet } = {}) {
  const r = spawnSync("kubectl", ["--context", ctx, ...args], { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw new Error(`can't run kubectl: ${r.error.message}`);
  if (!quiet && r.status !== 0) throw new Error(`kubectl ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const ns = ["-n", NAMESPACE];
const say = (s) => console.log(s);

function waitForJob(ctx, name, timeoutMs = 10 * 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = kubectl(ctx, ["get", "job", name, ...ns, "-o", "jsonpath={.status.succeeded}|{.status.conditions[?(@.type==\"Failed\")].status}"], { quiet: true });
    const [ok, failed] = r.out.split("|");
    if (r.ok && Number(ok) >= 1) return "complete";
    if (r.ok && failed === "True") return "failed";
    if (Date.now() > until) return "timeout";
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},3000)"]);
  }
}

function runJob(ctx, name, manifest, label) {
  kubectl(ctx, ["delete", "job", name, ...ns, "--ignore-not-found", "--wait=true"]);
  kubectl(ctx, ["apply", "-f", manifest]);
  say(`  ${label}: running (${name})`);
  const state = waitForJob(ctx, name);
  // Every pod the Job started (a failed attempt keeps its pod), prefixed with its name when there is more than one thing to tell apart.
  const logs = kubectl(ctx, ["logs", "-l", `job-name=${name}`, ...ns, "--all-containers", "--tail=200", `--prefix=${state !== "complete"}`], { quiet: true });
  const text = cleanLog(logs.out || logs.err);
  if (text) say(text.split("\n").map((l) => `    | ${l}`).join("\n"));
  if (state !== "complete") {
    const hint = explainFailure(text);
    throw new Error(`${label} did not finish (${state}).${hint ? `\n     ${hint}` : ""}\n     Logs above; \`kubectl --context ${ctx} describe job ${name} -n ${NAMESPACE}\` says more.`);
  }
  say(`  ${label}: done`);
}

function applyConfigMap(ctx) {
  const files = Object.entries(CONFIGMAP_FILES).map(([k, v]) => `--from-file=${k}=${v}`);
  const cm = kubectl(ctx, ["create", "configmap", CONFIGMAP, ...ns, "--dry-run=client", "-o", "yaml", ...files]);
  kubectl(ctx, ["apply", "-f", "-"], { input: cm.out });
  say(`  configmap ${CONFIGMAP}: refreshed`);
  return 0;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { say("see the header of scripts/keycloak-deploy.mjs"); return 0; }
  const problem = argProblem(a);
  if (problem) { console.error(`FAIL ${problem}`); return 2; }
  for (const f of Object.values(CONFIGMAP_FILES)) if (!existsSync(resolve(f))) { console.error(`FAIL ${f} not found: run this from the repository root`); return 2; }
  const ctx = a.context;

  // Read-only look.
  say(`context ${ctx}`);
  if (!kubectl(ctx, ["config", "get-contexts", ctx, "-o", "name"], { quiet: true }).ok) { console.error(`FAIL no such kube context: ${ctx}`); return 2; }
  const server = kubectl(ctx, ["config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"], { quiet: true }).out;
  say(`cluster ${server || "(unknown)"}, namespace ${NAMESPACE}`);
  const nsOk = kubectl(ctx, ["get", "namespace", NAMESPACE, "-o", "name"], { quiet: true });
  if (!nsOk.ok) { console.error(`FAIL can't reach the cluster or the ${NAMESPACE} namespace: ${nsOk.err.trim().slice(0, 300)}`); return 1; }
  if (a.configmapOnly) return applyConfigMap(ctx);
  const keys = kubectl(ctx, ["get", "secret", SECRET, ...ns, "-o", "go-template={{range $k, $v := .data}}{{$k}}{{\"\\n\"}}{{end}}"], { quiet: true });
  if (!keys.ok) { console.error(`FAIL no Secret ${SECRET} in ${NAMESPACE}: ${keys.err.trim().slice(0, 300)}`); return 1; }
  const missing = missingKeys(keys.out.split("\n").map((s) => s.trim()).filter(Boolean), requiredSecretKeys(a));
  if (missing.length) { console.error(`FAIL ${SECRET} lacks: ${missing.join(", ")}${missing.includes("CURF_KEYCLOAK_CONFIG_CLIENT_SECRET") ? "\n     (put `openssl rand -hex 32` there; at least 32 characters, then run with --bootstrap)" : ""}`); return 1; }
  say(`secret keys present: ${requiredSecretKeys(a).join(", ")}`);
  const kc = kubectl(ctx, ["get", "deployment", "curfai-keycloak", ...ns, "-o", "jsonpath={.status.readyReplicas}"], { quiet: true });
  if (!kc.ok || !Number(kc.out)) { console.error("FAIL Keycloak (deployment curfai-keycloak) isn't running and ready: roll out k8s/keycloak/keycloak.yaml first"); return 1; }
  say("keycloak is ready");

  if (!a.apply) {
    say("\nNothing changed. With --apply this would: refresh ConfigMap " + CONFIGMAP + (a.bootstrap ? `, run ${BOOTSTRAP_JOB}` : "") + `, run ${CONFIG_JOB}, run ${VERIFY_JOB}` + (a.networkPolicy ? ", apply networkpolicy.yaml" : "") + ".");
    return 0;
  }

  say("\napplying");
  applyConfigMap(ctx);
  if (a.networkPolicy) { kubectl(ctx, ["apply", "-f", "k8s/keycloak/networkpolicy.yaml"]); say("  networkpolicy curfai-keycloak-egress: applied"); }
  if (a.bootstrap) runJob(ctx, BOOTSTRAP_JOB, "k8s/keycloak/config-bootstrap-job.yaml", "bootstrap (the config Job's own client)");
  runJob(ctx, CONFIG_JOB, "k8s/keycloak/config-job.yaml", "realm sync");
  runJob(ctx, VERIFY_JOB, "k8s/keycloak/verify-job.yaml", "realm check");
  say("\nthe realm matches k8s/keycloak/realm/curf.json and the check passed");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main()); } catch (e) { console.error(`FAIL ${e.message}`); process.exit(1); }
}
