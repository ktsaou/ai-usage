import type { ProviderConfig, ProviderResult, SubscriptionInfo, UsageMetric } from "../types.js";

export function result(
  config: ProviderConfig,
  metrics: UsageMetric[],
  plan: string | null = null,
  error: string | null = null,
  subscription: SubscriptionInfo | null = null
): ProviderResult {
  return {
    providerId: config.id,
    providerType: config.type,
    name: config.name,
    plan,
    metrics,
    fetchedAt: Date.now(),
    error,
    subscription,
  };
}

export function metric(
  name: string,
  used: number | null,
  total: number | null,
  unit: string,
  window: string | null = null,
  resetsAt: number | null = null,
  extra: {
    note?: string;
    breakdown?: Record<string, number>;
    secondary?: boolean;
    rolling?: boolean;
    backstopped?: boolean;
    expiresAt?: number | null;
    coversUntil?: number | null;
  } = {}
): UsageMetric {
  const remaining = used !== null && total !== null ? total - used : null;
  const percent =
    used !== null && total !== null && total > 0
      ? Math.max(0, Math.min(100, (used / total) * 100))
      : null;
  return { name, used, total, remaining, percent, unit, window, resetsAt, ...extra };
}
