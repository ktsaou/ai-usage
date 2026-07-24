export const MINIMAX_ENDPOINTS = {
  intl: [
    "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
    "https://www.minimax.io/v1/token_plan/remains",
  ],
  cn: [
    "https://api.minimaxi.com/v1/token_plan/remains",
    "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains",
  ],
};

export interface MinimaxModelRemains {
  model_name: string;
  current_interval_total_count: number;
  current_interval_usage_count: number; // INTL: this is REMAINING (mislabeled!). CN: this is USED.
  current_interval_status?: number;
  current_interval_remaining_percent?: number;
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  current_weekly_status?: number;
  current_weekly_remaining_percent?: number;
  remains_time?: number;
  end_time?: number;
  weekly_remains_time?: number;
  weekly_end_time?: number;
}

export interface MinimaxResponse {
  base_resp: { status_code: number; status_msg: string };
  model_remains: MinimaxModelRemains[];
}

export function headers(subscriptionKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${subscriptionKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}
