export const ALIBABA_CODING_ENDPOINTS = {
  intl: "https://modelstudio.console.alibabacloud.com/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2&currentRegionId=ap-southeast-1",
  cn: "https://bailian.console.aliyun.com/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2&currentRegionId=cn-beijing",
};

export const COMMODITY_CODES = {
  intl: "sfm_codingplan_public_intl",
  cn: "sfm_codingplan_public_cn",
};

export interface AlibabaCodingQuotaInfo {
  per5HourUsedQuota: number;
  per5HourTotalQuota: number;
  per5HourQuotaNextRefreshTime: string;
  perWeekUsedQuota: number;
  perWeekTotalQuota: number;
  perWeekQuotaNextRefreshTime: string;
  perBillMonthUsedQuota: number;
  perBillMonthTotalQuota: number;
  perBillMonthQuotaNextRefreshTime: string;
}

export interface AlibabaCodingResponse {
  code: string;
  data: {
    codingPlanInstanceInfos: {
      codingPlanQuotaInfo: AlibabaCodingQuotaInfo;
    }[];
  };
}

// Auth: API key in multiple headers, or cookie fallback
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

export function body(region: "intl" | "cn"): string {
  return JSON.stringify({
    queryCodingPlanInstanceInfoRequest: {
      commodityCode: COMMODITY_CODES[region],
    },
  });
}
