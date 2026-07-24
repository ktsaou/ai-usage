import "dotenv/config";
import { MINIMAX_ENDPOINTS, headers } from "./index.js";

const key = process.env.MINIMAX_SUBSCRIPTION_KEY;
const region = (process.env.MINIMAX_REGION || "intl") as "intl" | "cn";

if (!key) {
  console.error("FAIL: MINIMAX_SUBSCRIPTION_KEY not set in .env");
  process.exit(1);
}

const endpoints = MINIMAX_ENDPOINTS[region];
console.log(`Region: ${region}`);
console.log(`Auth: ${key.slice(0, 6)}...${key.slice(-4)} (${key.length} chars)`);
console.log("---");

for (const url of endpoints) {
  console.log(`GET ${url}`);
  try {
    const res = await fetch(url, { headers: headers(key) });
    console.log(`Status: ${res.status} ${res.statusText}`);
    const body = await res.json();
    console.log(JSON.stringify(body, null, 2));
    if (res.ok && body.base_resp?.status_code === 0) {
      console.log("\n✓ SUCCESS");
      process.exit(0);
    }
  } catch (err: any) {
    console.error(`ERROR: ${err.message}`);
  }
  console.log("---");
}

console.error("FAIL: all endpoints failed");
process.exit(1);
