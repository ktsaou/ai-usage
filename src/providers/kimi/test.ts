import "dotenv/config";
import { KIMI_CODING_ENDPOINT, headers } from "./index.js";

const key = process.env.KIMI_CODING_API_KEY;
if (!key) {
  console.error("FAIL: KIMI_CODING_API_KEY not set in .env");
  process.exit(1);
}

if (!key.startsWith("sk-kimi-")) {
  console.warn(
    `WARN: key starts with "${key.slice(0, 8)}..." — expected "sk-kimi-xxx" format`
  );
}

console.log(`GET ${KIMI_CODING_ENDPOINT}`);
console.log(`Auth: ${key.slice(0, 10)}...${key.slice(-4)} (${key.length} chars)`);
console.log("---");

try {
  const res = await fetch(KIMI_CODING_ENDPOINT, { headers: headers(key) });
  console.log(`Status: ${res.status} ${res.statusText}`);
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
} catch (err: any) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
