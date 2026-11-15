/** Run as its own process by notices.redis.test.ts: another replica announcing a change. argv: <topic> <json payload> */
import { publishNotice } from "./notices";
import { closeRedis, redis } from "./index";

const [topic, payload] = process.argv.slice(2);
publishNotice(topic, JSON.parse(payload));
// publishNotice is fire-and-forget: make sure it has gone out before this process ends.
redis("cache").then((r) => r.ping()).then(async () => { await new Promise((r) => setTimeout(r, 300)); await closeRedis(); process.exit(0); });
