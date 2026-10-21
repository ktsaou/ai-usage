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

/**
 * Whether `msg` is a transport-level fetch rejection — the request never got
 * a response. Between polls chromium reuses pooled keep-alive sockets and
 * cached DNS for the console origins; when the peer has gone away underneath,
 * an in-page fetch rejects at this layer ("Failed to fetch", with the
 * `net::ERR_` code invisible to page JS). It is the one failure class that a
 * plain repeat heals, and these calls are read-only usage reads, so repeating
 * them is safe even when they are POSTs.
 */
export function isTransportFailure(msg: string): boolean {
  return /failed to fetch|fetch failed|net::ERR_/i.test(msg);
}

// Playwright prefixes its evaluations and appends stack frames
// ("... at eval (eval at evaluate (:303:30), <anonymous>:1:455) at ...").
// The journal keeps the full text; surfaces a human reads want the headline.
const STACK_FRAME = /\s+at\s+(?:eval\b|UtilityScript\b|<anonymous>|\S+\s*\(|[^ ]+:\d+:\d+)/;

/** Trim Playwright stack frames from error text meant for tiles and APIs. */
export function briefError(msg: string): string {
  const firstLine = msg.split("\n")[0]?.trim() ?? "";
  const cut = firstLine.search(STACK_FRAME);
  return (cut > 0 ? firstLine.slice(0, cut) : firstLine).trim();
}

/**
 * Run `call`, retrying once after a short backoff on a transport failure.
 * A single stale socket must not cost a whole poll cycle; anything else
 * (auth, shape, gateway errors) propagates untouched so the existing
 * logged-out and relogin paths stay authoritative.
 */
export async function withTransportRetry<T>(
  label: string,
  call: () => Promise<T>,
  opts: { retries?: number; backoffMs?: number } = {}
): Promise<T> {
  const retries = opts.retries ?? 1;
  const backoffMs = opts.backoffMs ?? 750;
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (attempt >= retries || !isTransportFailure(msg)) throw err;
      console.warn(`[providers] ${label}: transport failure, retrying: ${briefError(msg)}`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}
