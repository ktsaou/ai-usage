import "dotenv/config";
import {
  ALIBABA_CODING_ENDPOINTS,
  headersWithApiKey,
  headersWithCookie,
  body,
} from "./index.js";

const apiKey = process.env.ALIBABA_CODING_API_KEY;
const cookie = process.env.ALIBABA_CODING_COOKIE;
const region = (process.env.ALIBABA_CODING_REGION || "intl") as "intl" | "cn";

if (!apiKey && !cookie) {
  console.error(
    "FAIL: neither ALIBABA_CODING_API_KEY nor ALIBABA_CODING_COOKIE set in .env"
  );
  process.exit(1);
}

const url = ALIBABA_CODING_ENDPOINTS[region];
const reqBody = body(region);

console.log(`Region: ${region}`);
console.log(`POST ${url}`);
console.log(`Body: ${reqBody}`);
console.log("---");

const hdrs = apiKey ? headersWithApiKey(apiKey) : headersWithCookie(cookie!);
if (apiKey) {
  console.log(`Auth: API key ${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`);
} else {
  console.log(`Auth: cookie (${cookie!.length} chars)`);
}
console.log("---");

try {
  const res = await fetch(url, {
    method: "POST",
    headers: hdrs,
    body: reqBody,
  });
  console.log(`Status: ${res.status} ${res.statusText}`);
  const text = await res.text();
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text.slice(0, 2000));
  }
} catch (err: any) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
