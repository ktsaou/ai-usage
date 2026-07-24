export const ZAI_ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";

export interface ZaiLimit {
  type: "TOKENS_LIMIT" | "TIME_LIMIT";
  unit: number; // 3=5h tokens, 5=monthly MCP, 6=weekly tokens
  percentage: number;
  usage: number;
  total: number;
  remaining: number;
  nextResetTime: number;
  usageDetails?: { modelCode: string; usage: number }[];
}

export interface ZaiResponse {
  code: number;
  success: boolean;
  data: {
    limits: ZaiLimit[];
    planName?: string;
  };
}

// Auth: Authorization header with raw key (NO "Bearer" prefix)
export function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}
