import "dotenv/config";

// GAP: No verified endpoint for Alibaba Token Plan.
// This test attempts the same console RPC pattern with guessed action names.
// If none work, you'll need to capture the real request from browser DevTools.

const apiKey = process.env.ALIBABA_TOKEN_API_KEY || process.env.ALIBABA_CODING_API_KEY;
const cookie = process.env.ALIBABA_TOKEN_COOKIE || process.env.ALIBABA_CODING_COOKIE;
const region = (process.env.ALIBABA_TOKEN_REGION || "intl") as "intl" | "cn";

if (!apiKey && !cookie) {
  console.error(
    "FAIL: neither ALIBABA_TOKEN_API_KEY nor ALIBABA_TOKEN_COOKIE set in .env"
  );
  process.exit(1);
}

const base =
  region === "intl"
    ? "https://modelstudio.console.alibabacloud.com/data/api.json"
    : "https://bailian.console.aliyun.com/data/api.json";

// Guessed action names — likely wrong, but worth trying
const attempts = [
  {
    action: "zeldaEasy.broadscope-bailian.tokenPlan.queryTokenPlanInstanceInfo",
    body: { queryTokenPlanInstanceInfoRequest: {} },
  },
  {
    action: "zeldaEasy.broadscope-bailian.tokenPlan.queryTokenPlanUsage",
    body: { queryTokenPlanUsageRequest: {} },
  },
  {
    action: "zeldaEasy.broadscope-bailian.subscription.querySubscriptionInstanceInfo",
    body: { querySubscriptionInstanceInfoRequest: {} },
  },
];

const hdrs: Record<string, string> = apiKey
  ? {
      Authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
      "X-DashScope-API-Key": apiKey,
      "Content-Type": "application/json",
    }
  : { Cookie: cookie!, "Content-Type": "application/json" };

console.log(`Region: ${region}`);
console.log(`Auth: ${apiKey ? "API key" : "cookie"}`);
console.log("---");

for (const attempt of attempts) {
  const url = `${base}?action=${attempt.action}&product=broadscope-bailian`;
  console.log(`POST ${url}`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(attempt.body),
    });
    console.log(`Status: ${res.status} ${res.statusText}`);
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      console.log(JSON.stringify(json, null, 2));
      if (json.code === "200" || json.successResponse) {
        console.log("\n✓ FOUND WORKING ENDPOINT");
        console.log(`Action: ${attempt.action}`);
        process.exit(0);
      }
    } catch {
      console.log(text.slice(0, 500));
    }
  } catch (err: any) {
    console.error(`ERROR: ${err.message}`);
  }
  console.log("---");
}

console.log("None of the guessed endpoints worked.");
console.log(
  "To find the real endpoint: open Alibaba Cloud Model Studio console → Token Plan page → DevTools → Network → look for api.json calls"
);
