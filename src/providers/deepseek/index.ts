export const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/user/balance";

export interface DeepseekBalanceInfo {
  currency: "CNY" | "USD";
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

export interface DeepseekResponse {
  is_available: boolean;
  balance_infos: DeepseekBalanceInfo[];
}

export function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}
