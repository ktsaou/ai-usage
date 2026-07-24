import "dotenv/config";
import { ZAI_ENDPOINT, headers } from "./index.js";

const key = process.env.ZAI_API_KEY;
if (!key) {
  console.error("FAIL: ZAI_API_KEY not set in .env");
  process.exit(1);
}

console.log(`GET ${ZAI_ENDPOINT}`);
console.log(`Auth: ${key.slice(0, 6)}...${key.slice(-4)} (${key.length} chars)`);
console.log("---");

try {
  const res = await fetch(ZAI_ENDPOINT, { headers: headers(key) });
  console.log(`Status: ${res.status} ${res.statusText}`);
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
} catch (err: any) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
