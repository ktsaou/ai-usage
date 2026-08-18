import type { MetricAnchors } from "./db.js";
import type { ProviderResult, SubscriptionInfo, UsageMetric } from "./types.js";

/**
 * Will this quota run out before it resets?
 *
 * A percentage answers "how much is left", which is the wrong question when a
 * subscription is consumed by a whole team through a shared gateway: nobody can
 * see the pace, so 30% left reads as comfortable when it is two hours of work.
 * This turns stored history into the pace, the hours of headroom it implies,
 * and a level — the same error-budget burn-rate arithmetic used for SLOs.
 *
 * Everything here is expressed as **percent of the quota per hour**, whatever
 * the provider counts in, so a burn ratio is unitless and providers compare.
 */

const H = 3600000;

/** How the "now" rate is measured. Long enough to survive a pause between requests. */
const SHORT_LOOKBACK_MS = 1 * H;

/** How far back the peak-hour rate looks. */
const PEAK_WINDOW_MS = 24 * H;

/** Below this the two samples are too close together for their difference to mean anything. */
const MIN_SPAN_MS = 10 * 60000;

/** Reading the raw fill level. Mirrors `levelOf()` in the dashboard. */
const ELEVATED_PERCENT = 70;
const CRITICAL_PERCENT = 90;

const WINDOW_MS: Record<string, number> = {
  "5h": 5 * H,
  daily: 24 * H,
  weekly: 7 * 24 * H,
  monthly: 30 * 24 * H,
};

/**
 * `down` is worse than `crit`: at risk means it will run out, down means there
 * is nothing to run out of — the plan is not usable, or cannot be read at all.
 */
export type RiskLevel = "ok" | "warn" | "crit" | "down";

export interface MetricRisk {
  level: RiskLevel;
  /** Percent of the quota consumed per hour, measured over the last hour. */
  ratePerHour: number | null;
  /** The worst single hour of the last 24, in the same unit. */
  peakRatePerHour: number | null;
  /** Hours until this quota is gone at `ratePerHour`. Null when nothing is burning. */
  headroomHours: number | null;
  /** The same at `peakRatePerHour` — what a resumed burst would cost. */
  peakHeadroomHours: number | null;
  /** `ratePerHour` over the rate this quota can afford until its deadline. Above 1 means it runs out first. */
  burnRatio: number | null;
  /** Hours until the reset — or one window length for a rolling window, which has no reset. */
  horizonHours: number | null;
  rolling: boolean;
  /** The horizon is a window this pool has to cover, not a reset of its own. */
  bridging: boolean;
}

export interface SubscriptionRisk {
  level: RiskLevel;
  endsAt: number | null;
  hoursLeft: number | null;
  autoRenew: boolean | null;
  status: string | null;
  /** The term ran out and the provider has not moved it on: nothing renewed. */
  expired: boolean;
}

export interface ProviderRisk {
  level: RiskLevel;
  /** The window that binds first — the one the level came from. */
  metric: string | null;
  window: string | null;
  /** The plan's own deadline, which can outrank every quota on it. */
  subscription: SubscriptionRisk | null;
  /**
   * That window's figures, whole. Embedded rather than copied out field by
   * field, so a number added to `MetricRisk` cannot go missing here.
   */
  binding: MetricRisk | null;
  /** Per metric, keyed by metric name. */
  metrics: Record<string, MetricRisk>;
}

/** What the risk model needs from storage. `DB` satisfies it. */
export interface RiskHistory {
  metricAnchors(providerId: string, metricName: string, lookbackMs: number): MetricAnchors | null;
  peakHourlyRise(providerId: string, metricName: string, since: number): number | null;
}

const RANK: Record<RiskLevel, number> = { ok: 0, warn: 1, crit: 2, down: 3 };
const worst = (a: RiskLevel, b: RiskLevel): RiskLevel => (RANK[b] > RANK[a] ? b : a);

function fillLevel(percent: number): RiskLevel {
  if (percent >= CRITICAL_PERCENT) return "crit";
  if (percent >= ELEVATED_PERCENT) return "warn";
  return "ok";
}

function windowMs(metric: UsageMetric): number | null {
  return metric.window ? WINDOW_MS[metric.window] ?? null : null;
}

/** Percent of the quota per hour between two samples, or null if they are too close. */
function rateFrom(anchors: MetricAnchors | null): number | null {
  if (!anchors) return null;
  const span = anchors.last.t - anchors.base.t;
  if (span < MIN_SPAN_MS) return null;
  return (anchors.last.v - anchors.base.v) / (span / H);
}

export function computeMetricRisk(
  history: RiskHistory,
  providerId: string,
  metric: UsageMetric,
  now: number
): MetricRisk | null {
  if (metric.percent === null || metric.percent === undefined) return null;

  const remaining = Math.max(0, 100 - metric.percent);
  const rolling = metric.rolling === true;

  // A rolling window never resets, so nothing is "left until" anything; the
  // question becomes whether the trailing window saturates within its own
  // length at this trend.
  //
  // A pool with no reset of its own can still have a deadline: when it is the
  // backstop for a spent window, it has to last until that window resets, and
  // `coversUntil` carries that moment. Without it such a pool could never be at
  // risk however fast it drained — there was nothing to measure the burn
  // against — which is exactly the case the packs exist for.
  const wMs = windowMs(metric);
  const bridging = !rolling && !metric.resetsAt && !!metric.coversUntil;
  const horizonMs = rolling
    ? wMs
    : metric.resetsAt
      ? metric.resetsAt - now
      : metric.coversUntil
        ? metric.coversUntil - now
        : null;
  const horizonHours = horizonMs !== null && horizonMs > 0 ? horizonMs / H : null;

  const short = rateFrom(history.metricAnchors(providerId, metric.name, SHORT_LOOKBACK_MS));
  const peakRise = history.peakHourlyRise(providerId, metric.name, now - PEAK_WINDOW_MS);

  const ratePerHour = short !== null ? Math.max(0, short) : null;
  const peakRatePerHour = peakRise !== null ? Math.max(0, peakRise) : null;
  const headroomHours = ratePerHour && ratePerHour > 0 ? remaining / ratePerHour : null;
  const peakHeadroomHours =
    peakRatePerHour && peakRatePerHour > 0 ? remaining / peakRatePerHour : null;

  // The rate this quota can afford: spend exactly the remainder by the deadline.
  const sustainable = horizonHours !== null ? remaining / horizonHours : null;
  const burnRatio =
    sustainable !== null && sustainable > 0 && ratePerHour !== null ? ratePerHour / sustainable : null;

  // How full a quota is only decides the level when the pace cannot: a quota at
  // 84% burning 1%/h with 16h of headroom and a reset 4h away is not elevated,
  // it is fine, and saying otherwise is the same misreading of a percentage this
  // whole model exists to replace. With no rate and no peak there is nothing to
  // judge by, and then fullness is all there is.
  const judgeable = horizonHours !== null && (headroomHours !== null || peakHeadroomHours !== null);
  let level: RiskLevel = judgeable ? "ok" : fillLevel(metric.percent);
  if (remaining <= 0) {
    level = "crit";
  } else if (sustainable !== null && short !== null && short > sustainable) {
    // At the current rate it does not reach its deadline. Measured over the last
    // 60 minutes only: a confirming longer lookback was tried and dropped by
    // decision, because it delayed red by up to an hour to avoid a few red/green
    // switches a day (15 false-alarm windows out of 251 against 13, 269
    // switches against 225, over 14 days of stored history).
    level = "crit";
  } else if (horizonHours !== null && peakHeadroomHours !== null && peakHeadroomHours < horizonHours) {
    // The current rate arrives, but the worst hour of the last 24 would not.
    level = worst(level, "warn");
  }

  return {
    level,
    ratePerHour,
    peakRatePerHour,
    headroomHours,
    peakHeadroomHours,
    burnRatio,
    horizonHours,
    rolling,
    bridging,
  };
}

/**
 * The subscription term's end is a **renewal anniversary**, and on an
 * auto-renewing plan nothing observable happens there: the term rolls over, the
 * quotas keep their own schedules. Counting down to it says nothing, so nothing
 * counts down to it any more.
 *
 * What does mean something is the date going **past** without the provider
 * moving it on — a cancelled plan, or a payment that failed. Then the plan is
 * gone, whatever the quota numbers still say, and that is `down`.
 *
 * The grace period is because vendors update this lazily: the term can sit a few
 * minutes past its end before the renewed date appears, and a card must not
 * flash "did not renew" at every anniversary.
 */
const RENEWAL_GRACE_H = 1;

export function computeSubscriptionRisk(
  sub: SubscriptionInfo | null | undefined,
  now: number
): SubscriptionRisk | null {
  if (!sub) return null;
  const hoursLeft = sub.endsAt ? (sub.endsAt - now) / H : null;
  const expired = hoursLeft !== null && hoursLeft < -RENEWAL_GRACE_H;
  const invalid = !!sub.status && sub.status !== "VALID";
  return {
    level: expired || invalid ? "down" : "ok",
    endsAt: sub.endsAt,
    hoursLeft,
    autoRenew: sub.autoRenew,
    status: sub.status,
    expired,
  };
}

/** How soon this metric becomes a problem, for picking the binding window. */
function urgency(r: MetricRisk): number {
  return Math.min(r.headroomHours ?? Infinity, r.peakHeadroomHours ?? Infinity);
}

/**
 * The risk of a provider is the risk of whichever window binds first, or of the
 * plan itself when that expires sooner than any quota runs out. Quotas flagged
 * `secondary` measure something other than the plan's usage, and quotas flagged
 * `backstopped` are spent but covered by another pool; both carry their own risk
 * and neither speaks for the provider.
 */
export function computeProviderRisk(
  history: RiskHistory,
  result: ProviderResult,
  now = Date.now()
): ProviderRisk | null {
  if (result.error || !result.metrics?.length) return null;

  const metrics: Record<string, MetricRisk> = {};
  for (const m of result.metrics) {
    const r = computeMetricRisk(history, result.providerId, m, now);
    if (r) metrics[m.name] = r;
  }
  const subscription = computeSubscriptionRisk(result.subscription, now);

  const eligible = result.metrics.filter((m) => !m.secondary && !m.backstopped && metrics[m.name]);
  if (!eligible.length) {
    if (!Object.keys(metrics).length && !subscription) return null;
    return {
      level: subscription?.level ?? "ok",
      metric: null,
      window: null,
      subscription,
      binding: null,
      metrics,
    };
  }

  const binding = eligible.reduce((a, b) => {
    const ra = metrics[a.name];
    const rb = metrics[b.name];
    if (RANK[rb.level] !== RANK[ra.level]) return RANK[rb.level] > RANK[ra.level] ? b : a;
    return urgency(rb) < urgency(ra) ? b : a;
  });
  const r = metrics[binding.name];
  return {
    level: subscription ? worst(r.level, subscription.level) : r.level,
    metric: binding.name,
    window: binding.window,
    subscription,
    binding: r,
    metrics,
  };
}
