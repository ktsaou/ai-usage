import "dotenv/config";
import { MIMO_USAGE_ENDPOINT, MIMO_DETAIL_ENDPOINT, headers } from "./index.js";

const serviceToken = process.env.MIMO_COOKIE_SERVICETOKEN;
const userId = process.env.MIMO_COOKIE_USERID;

if (!serviceToken || !userId) {
  console.error(
    "FAIL: MIMO_COOKIE_SERVICETOKEN and/or MIMO_COOKIE_USERID not set in .env"
  );
  console.error(
    "See CREDS.md for instructions on extracting these from your browser."
  );
  process.exit(1);
}

console.log(`Auth: serviceToken=${serviceToken.slice(0, 8)}... (${serviceToken.length} chars), userId=${userId.slice(0, 3)}... (${userId.length} chars)`);
console.log("---");

console.log(`GET ${MIMO_USAGE_ENDPOINT}`);
try {
  const res = await fetch(MIMO_USAGE_ENDPOINT, {
    headers: headers(serviceToken, userId),
  });
  console.log(`Status: ${res.status} ${res.statusText}`);
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
} catch (err: any) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}

console.log("---");
console.log(`GET ${MIMO_DETAIL_ENDPOINT}`);
try {
  const res = await fetch(MIMO_DETAIL_ENDPOINT, {
    headers: headers(serviceToken, userId),
  });
  console.log(`Status: ${res.status} ${res.statusText}`);
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
} catch (err: any) {
  console.error(`ERROR: ${err.message}`);
}
