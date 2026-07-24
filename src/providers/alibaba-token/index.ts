// GAP: No verified endpoint found for Alibaba Token Plan usage.
// The Token Plan is a different product from the Coding Plan.
// Likely follows the same console RPC pattern with a different action/commodityCode.
// Needs manual network inspection of the Alibaba Cloud Model Studio console
// while on the Token Plan page.
//
// Expected pattern (UNVERIFIED):
// POST https://modelstudio.console.alibabacloud.com/data/api.json?action=zeldaEasy.broadscope-bailian.tokenPlan.<something>
// Body: {"queryTokenPlanInstanceInfoRequest": {"commodityCode": "sfm_tokenplan_..."}}
//
// Auth: same as alibaba-coding (API key headers or cookie fallback)

export const ALIBABA_TOKEN_ENDPOINTS = {
  intl: "https://modelstudio.console.alibabacloud.com/data/api.json",
  cn: "https://bailian.console.aliyun.com/data/api.json",
};

export function headersWithApiKey(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    "X-DashScope-API-Key": apiKey,
    "Content-Type": "application/json",
  };
}

export function headersWithCookie(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    "Content-Type": "application/json",
  };
}
