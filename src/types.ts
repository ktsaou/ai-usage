export interface UsageMetric {
  name: string;
  used: number | null;
  total: number | null;
  remaining: number | null;
  percent: number | null;
  unit: string;
  window: string | null;
  resetsAt: number | null;
  /** What this quota actually measures, when the name alone invites misreading. */
  note?: string;
  /** Per-item split of `used`, when the provider reports one. */
  breakdown?: Record<string, number>;
  /**
   * This quota measures something other than the plan's usage, so it must never
   * headline a card — its percentage is not comparable with the others. Only
   * the provider module knows this; the renderers must not guess from names.
   */
  secondary?: boolean;
  /**
   * A trailing window rather than one that resets: `used` is what was consumed
   * over the last window length and falls again as that usage ages out, so
   * there is no reset instant to count down to and no reset to extrapolate to.
   * Only the provider module can tell — the API field naming does not.
   */
  rolling?: boolean;
  /**
   * This window is spent, but another quota on the same provider covers it, so
   * it does not block work: the provider keeps serving from the other pool.
   * Such a window must not headline a card or drive the provider's risk — it
   * would report "blocked" while everything still works — but it keeps its own
   * exhausted state. Only the provider module knows a backstop exists.
   */
  backstopped?: boolean;
  /**
   * When this allowance is lost, for quotas that expire instead of resetting.
   * Unlike `resetsAt` nothing comes back afterwards.
   */
  expiresAt?: number | null;
}

/** The plan itself, as distinct from what it allows: when it ends, and whether it renews. */
export interface SubscriptionInfo {
  endsAt: number | null;
  remainingDays: number | null;
  autoRenew: boolean | null;
  /** Provider's own word for it, e.g. `VALID`. */
  status: string | null;
}

export interface ProviderResult {
  providerId: string;
  providerType: string;
  name: string;
  plan: string | null;
  metrics: UsageMetric[];
  fetchedAt: number;
  error: string | null;
  /** Descriptive like the metric extras: passed through, never stored. */
  subscription?: SubscriptionInfo | null;
}

export interface ProviderConfig {
  id: string;
  type: string;
  name: string;
  env: Record<string, string>;
  playwright?: boolean;
  parked?: boolean;
  payg?: "balance" | "spend" | "budget";
  spendWindowDays?: number;
  monthlyBudget?: number;
  balanceWarnDays?: number;
  balanceCritDays?: number;
  pollIntervalSeconds?: number;
}

export interface IngestConfig {
  apiKeys: Record<string, string>;
}

export interface AppConfig {
  service?: { name?: string; tagline?: string };
  port: number;
  pollIntervalSeconds: number;
  /** Samples older than this are deleted daily. Defaults to 90. */
  retentionDays?: number;
  dbPath: string;
  providers: ProviderConfig[];
  ingest: IngestConfig;
}

export interface IngestPayload {
  agent: string;
  provider: string;
  metrics: UsageMetric[];
  timestamp?: number;
}
