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
}

export interface ProviderResult {
  providerId: string;
  providerType: string;
  name: string;
  plan: string | null;
  metrics: UsageMetric[];
  fetchedAt: number;
  error: string | null;
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
