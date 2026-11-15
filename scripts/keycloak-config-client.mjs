// Gives the realm config Job (k8s/keycloak/config-job.yaml) an identity of its own, so it doesn't sign in as Keycloak's bootstrap admin.
//
// Creates (or brings back to what is described here) a client `curf-config` in Keycloak's master realm: a service account, no browser
// sign-in, whose only roles are the management roles of the `curf` realm (the master realm's `curf-realm` client: what a realm administrator holds). It can reconcile the curf realm
// and nothing else: not the master realm, not other realms, not Keycloak's server settings. Idempotent: run it again to rotate the
// secret or to repair the role. Plain node, no dependencies: it runs in a node image from the Job's ConfigMap, or by hand.
//
//   KC_URL=http://curfai-keycloak:8080  KC_ADMIN_USER=admin  KC_ADMIN_PASSWORD=...  CURF_KEYCLOAK_CONFIG_CLIENT_SECRET=<32+ random chars>
//   node keycloak-config-client.mjs
//
// The secret is chosen by whoever owns the Kubernetes Secret (`openssl rand -hex 32`) and is set on the client here; it is never printed.
// The bootstrap admin is needed for this one step only, and once the client exists the Job (and a person with the same secret) can do
// everything else without it: after that the bootstrap admin can be given a strong password nobody knows, or removed.
//
// Exit 0 = the client exists with the right secret and role, and the checks at the end passed.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KC = (process.env.KC_URL ?? "http://localhost:8180").replace(/\/$/, "");
const REALM = process.env.KC_REALM ?? "curf";
const CLIENT_ID = process.env.CURF_KEYCLOAK_CONFIG_CLIENT_ID ?? "curf-config";
const SECRET = process.env.CURF_KEYCLOAK_CONFIG_CLIENT_SECRET ?? "";

export const MIN_SECRET_LENGTH = 32;

const form = (o) => new URLSearchParams(o);
async function token(body) {
  const r = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(body) });
  if (!r.ok) throw new Error(`sign-in to Keycloak failed (${r.status})`);
  return (await r.json()).access_token;
}

async function main() {
  if (SECRET.length < MIN_SECRET_LENGTH) throw new Error(`CURF_KEYCLOAK_CONFIG_CLIENT_SECRET must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -hex 32)`);
  const T = await token({ grant_type: "password", client_id: "admin-cli", username: process.env.KC_ADMIN_USER ?? "admin", password: process.env.KC_ADMIN_PASSWORD ?? "" });
  const call = async (method, path, body, ok = []) => {
    const r = await fetch(`${KC}/admin/realms/master${path}`, { method, headers: { authorization: `Bearer ${T}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok && !ok.includes(r.status)) throw new Error(`${method} ${path.split("?")[0]} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r;
  };
  const one = async (path) => (await (await call("GET", path)).json())[0];

  const wanted = {
    clientId: CLIENT_ID, name: "Curf realm configuration (keycloak-config-cli)", enabled: true, protocol: "openid-connect",
    publicClient: false, serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false, implicitFlowEnabled: false,
    clientAuthenticatorType: "client-secret", secret: SECRET,
  };
  let client = await one(`/clients?clientId=${encodeURIComponent(CLIENT_ID)}`);
  if (client) {
    await call("PUT", `/clients/${client.id}`, { ...client, ...wanted });
    console.log(`client ${CLIENT_ID}: updated (secret set)`);
  } else {
    await call("POST", "/clients", wanted);
    client = await one(`/clients?clientId=${encodeURIComponent(CLIENT_ID)}`);
    console.log(`client ${CLIENT_ID}: created`);
  }

  // Its one role: realm-admin of the curf realm (the master realm holds a `<realm>-realm` client for each realm it manages).
  const sa = await (await call("GET", `/clients/${client.id}/service-account-user`)).json();
  const realmClient = await one(`/clients?clientId=${encodeURIComponent(`${REALM}-realm`)}`);
  if (!realmClient) throw new Error(`Keycloak has no realm "${REALM}" yet: start Keycloak with the realm import first`);
  const roles = await (await call("GET", `/clients/${realmClient.id}/roles`)).json();
  const held = new Set((await (await call("GET", `/users/${sa.id}/role-mappings/clients/${realmClient.id}`)).json()).map((r) => r.name));
  const missing = roles.filter((r) => !held.has(r.name));
  if (missing.length) await call("POST", `/users/${sa.id}/role-mappings/clients/${realmClient.id}`, missing);
  console.log(`service account: every management role of ${REALM} (${roles.length}), nothing in other realms`);

  // Prove it: it can sign in, reach the curf realm, and reach nothing else.
  const own = await token({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: SECRET });
  const probe = async (path) => (await fetch(`${KC}/admin/realms${path}`, { headers: { authorization: `Bearer ${own}` } })).status;
  // (Keycloak answers a bare GET of the master realm with its name to anyone who administers another realm, so probe what matters.)
  const [inCurf, usersMaster, clientsMaster] = [await probe(`/${REALM}/clients?max=1`), await probe("/master/users?max=1"), await probe("/master/clients?max=1")];
  if (inCurf !== 200) throw new Error(`the new client can't read the ${REALM} realm's clients (${inCurf})`);
  if (usersMaster === 200 || clientsMaster === 200) throw new Error("the new client can read the master realm: its role is wider than intended");
  console.log(`check: reads ${REALM} (200); master's users and clients are refused (${usersMaster}, ${clientsMaster})`);
}

// Compared by real path: a ConfigMap mount is a chain of symlinks, and the module URL is the resolved one, argv[1] is not.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1); });
}
