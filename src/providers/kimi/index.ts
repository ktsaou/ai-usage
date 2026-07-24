export const KIMI_CODING_ENDPOINT = "https://api.kimi.com/coding/v1/usages";

export interface KimiUsageDetail {
  limit: number;
  used: number;
  remaining: number;
  resetTime?: string | number;
  reset_at?: string | number;
  reset_in?: number;
}

export interface KimiLimitEntry {
  name?: string;
  window: { duration: number; timeUnit: string };
  detail: KimiUsageDetail;
}

export interface KimiResponse {
  usage?: KimiUsageDetail;
  limits?: KimiLimitEntry[];
  data?: {
    usage?: KimiUsageDetail;
    limits?: KimiLimitEntry[];
  };
}

// Auth: Bearer token with sk-kimi-xxx key
export function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}
