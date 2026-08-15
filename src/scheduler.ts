import type { AppConfig, ProviderResult } from "./types.js";
import { fetchProvider } from "./providers/fetch.js";
import { DB } from "./db.js";
import { computeProviderRisk, type ProviderRisk } from "./risk.js";

export class Scheduler {
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private lastResults: Map<string, ProviderResult> = new Map();
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
    this.lastResults.set(providerId, result);

    if (result.error) {
      console.error(`[scheduler] ${providerId}: ERROR ${result.error}`);
    } else {
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
    this.lastResults.set(providerId, result);
    if (!result.error) {
      this.db.store(result);
      this.updateRisk(result);
    }
    return result;
  }

  getLastResult(providerId: string): ProviderResult | undefined {
    return this.lastResults.get(providerId);
  }

  getRisk(providerId: string): ProviderRisk | undefined {
    return this.risks.get(providerId);
  }

  getAllLastResults(): ProviderResult[] {
    return [...this.lastResults.values()];
  }
}
