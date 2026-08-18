import type { AppConfig, ProviderResult } from "./types.js";
import { fetchProvider } from "./providers/fetch.js";
import { DB } from "./db.js";
import { computeProviderRisk, type ProviderRisk } from "./risk.js";

/**
 * How a provider is doing, as distinct from what its quotas say.
 *
 * `stale` exists because a single failed poll is not an outage. A one-second
 * network fault made three providers report `down` for a minute, which read as
 * "these subscriptions are gone" — the strongest alarm the monitor has, for a
 * blip that happens a handful of times on a normal day. One miss now keeps the
 * last good numbers and says how old they are; it takes two to call it down.
 */
export type ProviderState = "ok" | "stale" | "down";

/** Consecutive failed polls before a provider is reported down. */
const DOWN_AFTER_FAILURES = 2;

/**
 * `down` needs two consecutive failures **and** is the only outcome when there
 * is nothing cached to fall back on — a provider that has never answered cannot
 * be called merely stale.
 */
export function providerState(failures: number, hasCachedResult: boolean): ProviderState {
  if (failures === 0) return "ok";
  return hasCachedResult && failures < DOWN_AFTER_FAILURES ? "stale" : "down";
}

export interface ProviderHealth {
  state: ProviderState;
  /** The last poll that succeeded. Kept through failures so it can still be served. */
  result: ProviderResult | null;
  failures: number;
  error: string | null;
  erroredAt: number | null;
}

export class Scheduler {
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private lastResults: Map<string, ProviderResult> = new Map();
  private failures: Map<string, { count: number; error: string; at: number }> = new Map();
  private risks: Map<string, ProviderRisk> = new Map();
  private config: AppConfig;
  private db: DB;
  onResult?: (result: ProviderResult) => void;

  constructor(config: AppConfig, db: DB) {
    this.config = config;
    this.db = db;
  }

  start(): void {
    for (const provider of this.config.providers) {
      if (provider.parked) continue;
      const interval = (provider.pollIntervalSeconds || this.config.pollIntervalSeconds) * 1000;
      this.poll(provider.id);
      const timer = setInterval(() => this.poll(provider.id), interval);
      this.timers.set(provider.id, timer);
    }
    console.log(
      `[scheduler] started polling ${this.timers.size} providers (interval: ${this.config.pollIntervalSeconds}s)`
    );
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  private async poll(providerId: string): Promise<void> {
    const config = this.config.providers.find((p) => p.id === providerId);
    if (!config) return;

    const result = await fetchProvider(config);

    if (result.error) {
      // The previous good result is deliberately kept: it is what gets served,
      // labelled with its age, until a second consecutive failure.
      const prev = this.failures.get(providerId);
      this.failures.set(providerId, {
        count: (prev?.count ?? 0) + 1,
        error: result.error,
        at: result.fetchedAt,
      });
      console.error(`[scheduler] ${providerId}: ERROR ${result.error}`);
    } else {
      this.lastResults.set(providerId, result);
      this.failures.delete(providerId);
      this.db.store(result);
      this.updateRisk(result);
      console.log(`[scheduler] ${providerId}: ${result.metrics.length} metrics stored`);
    }

    this.onResult?.(result);
  }

  /**
   * Burn rates are derived once per poll and cached, not per HTTP request: the
   * inputs only change when a sample lands, and the dashboard, /metrics and the
   * MCP would otherwise each pay for the same queries, multiplied by viewers.
   *
   * A failed poll leaves the previous risk in place, the same way the dashboard
   * keeps showing the last good numbers — a fetch error is not evidence that
   * anything about the quota changed.
   */
  private updateRisk(result: ProviderResult): void {
    try {
      const risk = computeProviderRisk(this.db, result);
      if (risk) this.risks.set(result.providerId, risk);
      else this.risks.delete(result.providerId);
    } catch (err: any) {
      console.error(`[scheduler] ${result.providerId}: risk computation failed: ${err.message}`);
    }
  }

  async queryNow(providerId: string): Promise<ProviderResult> {
    const config = this.config.providers.find((p) => p.id === providerId);
    if (!config) {
      return {
        providerId,
        providerType: "unknown",
        name: providerId,
        plan: null,
        metrics: [],
        fetchedAt: Date.now(),
        error: `provider not found: ${providerId}`,
      };
    }
    if (config.parked) {
      return {
        providerId,
        providerType: config.type,
        name: config.name,
        plan: null,
        metrics: [],
        fetchedAt: Date.now(),
        error: null,
      };
    }
    const result = await fetchProvider(config);
    if (!result.error) {
      this.lastResults.set(providerId, result);
      this.failures.delete(providerId);
      this.db.store(result);
      this.updateRisk(result);
    }
    // A failure here does not count towards `down`. This runs on demand — an
    // MCP caller could otherwise drive a provider down by asking twice — so the
    // scheduler's own cadence stays the authority on whether one is dead.
    return result;
  }

  /** The last poll that succeeded, which may predate one or more failures. */
  getLastResult(providerId: string): ProviderResult | undefined {
    return this.lastResults.get(providerId);
  }

  getHealth(providerId: string): ProviderHealth {
    const result = this.lastResults.get(providerId) ?? null;
    const f = this.failures.get(providerId);
    const failures = f?.count ?? 0;
    const state = providerState(failures, !!result);
    return { state, result, failures, error: f?.error ?? null, erroredAt: f?.at ?? null };
  }

  getRisk(providerId: string): ProviderRisk | undefined {
    return this.risks.get(providerId);
  }

  getAllLastResults(): ProviderResult[] {
    return [...this.lastResults.values()];
  }
}
