import "dotenv/config";

const apiKey = process.env.ALIBABA_CODING_API_KEY!;
if (!apiKey) {
  console.error("FAIL: ALIBABA_CODING_API_KEY not set");
  process.exit(1);
}

const gateway = "https://bailian-singapore-cs.alibabacloud.com/data/api.json";
const api = "zeldaEasy.bailian-commerce.codingPlan.queryCodingPlanInstanceInfoV2";

const params = JSON.stringify({
  Api: api,
  V: "1.0",
  Data: {
    queryCodingPlanInstanceInfoRequest: {
      commodityCode: "sfm_codingplan_public_intl",
      onlyLatestOne: true,
    },
    cornerstoneParam: {
      protocol: "V2",
      console: "ONE_CONSOLE",
      productCode: "p_efm",
      domain: "modelstudio.console.alibabacloud.com",
      consoleSite: "MODELSTUDIO_ALBABACLOUD",
      xsp_lang: "en-US",
    },
  },
});

const body = `params=${encodeURIComponent(params)}&region=ap-southeast-1`;

console.log(`POST ${gateway}?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=${api}`);
console.log(`Auth: API key ${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`);
console.log("---");

const res = await fetch(
  `${gateway}?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=${api}&_v=undefined`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
      "X-DashScope-API-Key": apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  }
);

console.log(`Status: ${res.status}`);
const json = await res.json();
console.log(JSON.stringify(json, null, 2));
