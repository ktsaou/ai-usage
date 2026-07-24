export const MIMO_USAGE_ENDPOINT =
  "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage";
export const MIMO_DETAIL_ENDPOINT =
  "https://platform.xiaomimimo.com/api/v1/tokenPlan/detail";

export interface MimoUsageItem {
  name: string; // "plan_total_token" is the one we want
  used: number;
  limit: number;
  percent: number; // 0-1 fraction, NOT 0-100
}

export interface MimoUsageResponse {
  code: number;
  data: {
    usage: {
      items: MimoUsageItem[];
    };
  };
}

export interface MimoDetailResponse {
  code: number;
  data: {
    currentPeriodEnd?: string;
    planName?: string;
  };
}

// Auth: session cookies (API keys return 401 for quota endpoints)
export function headers(
  serviceToken: string,
  userId: string
): Record<string, string> {
  return {
    Cookie: `serviceToken=${serviceToken}; userId=${userId}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}
