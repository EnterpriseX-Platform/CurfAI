// A tiny stand-in identity provider so the conformance suite can run anywhere (CI, a laptop) without
// Keycloak. It serves a JWKS and mints RS256 tokens on request. Never use it outside tests.
//
//   node tools/mock-idp.mjs [--port 9099] [--issuer https://idp.test/realms/main]
//   GET /jwks                                   -> the public key set the engine should trust
//   GET /token?sub=u1&tenant=t1&roles=a,b&attr.agency_code=A001 -> a signed access token (plain text)
import { createServer } from "node:http";
import { createSign, generateKeyPairSync } from "node:crypto";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(opt("port", 9099));
const issuer = opt("issuer", "https://idp.test/realms/main");

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "mock", alg: "RS256", use: "sig" };

const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function mint(query) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: issuer,
    sub: query.get("sub") ?? "mock-user",
    preferred_username: query.get("sub") ?? "mock-user",
    iat: now,
    exp: now + 3600,
    realm_access: { roles: (query.get("roles") ?? "").split(",").filter(Boolean) },
  };
  if (query.get("tenant")) claims.tenant = query.get("tenant");
  for (const [key, value] of query) {
    if (key.startsWith("attr.")) claims[key.slice(5)] = value;
  }
  const signingInput = `${b64({ alg: "RS256", typ: "JWT", kid: "mock" })}.${b64(claims)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === "/jwks") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  } else if (url.pathname === "/token") {
    res.writeHead(200, { "content-type": "text/plain" }).end(mint(url.searchParams));
  } else {
    res.writeHead(404).end();
  }
}).listen(port, "0.0.0.0", () => console.log(`mock idp on :${port} issuer=${issuer}`));
