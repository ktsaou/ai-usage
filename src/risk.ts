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

/**
 * The peak rate is a planning figure, not a forecast: the honest question it
 * answers is "if the team works like its worst recent hour, does this survive
 * the night". Projecting a peak hour across a whole month never survives
 * contact with reality, so the test is capped here.
 */
const PLANNING_HORIZON_H = 12;

/**
 * The longest the confirming lookback may be. It was 6h, which a quota with no
 * declared window reached by default — so the pool with the *shortest* useful
 * signal got the *longest* smoothing, and a burst that had been over budget for
 * hours still read as ok because the six-hour average had not caught up.
 *
 * Backtested over 14 days of this deployment's history: at 2h the rule still
 * warns before all three real exhaustions, with the same 13 false-alarm windows
 * out of 251 as at 6h (duty 7.00% against 6.25%, 225 red/green transitions
 * against 183). Dropping the confirmation altogether was worse on every count —
 * 15 false-alarm windows and 269 transitions.
 */
const CONFIRM_CAP_MS = 2 * H;

/** Below this the two samples are too close together for their difference to mean anything. */
const MIN_SPAN_MS = 10 * 60000;

/** Reading the raw fill level. Mirrors `levelOf()` in the dashboard. */
const ELEVATED_PERCENT = 70;
const CRITICAL_PERCENT = 90;

/**
 * A plan that ends soon and will not renew itself takes the quota with it, so it
 * is a risk of the same kind — but only when nobody has to act. With
 * auto-renewal on, the end date is an accounting detail.
 */
const PLAN_EXPIRY_WARN_H = 7 * 24;
const PLAN_EXPIRY_CRIT_H = 48;

const WINDOW_MS: Record<string, number> = {
  "5h": 5 * H,
  daily: 24 * H,
  weekly: 7 * 24 * H,
  monthly: 30 * 24 * H,
};

export type RiskLevel = "ok" | "warn" | "crit";

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

const RANK: Record<RiskLevel, number> = { ok: 0, warn: 1, crit: 2 };
const worst = (a: RiskLevel, b: RiskLevel): RiskLevel => (RANK[b] > RANK[a] ? b : a);

function fillLevel(percent: number): RiskLevel {
  if (percent >= CRITICAL_PERCENT) return "crit";
  if (percent >= ELEVATED_PERCENT) return "warn";
  return "ok";
}

function windowMs(metric: UsageMetric): number | null {
  return metric.window ? WINDOW_MS[metric.window] ?? null : null;
}

/**
 * The confirming lookback. A single short measurement flips to critical on one
 * busy minute and back on the next; requiring a longer one to agree is what
 * makes the level stable enough to leave on a screen.
 */
function longLookbackMs(metric: UsageMetric): number {
  const w = windowMs(metric) ?? 7 * 24 * H;
  return Math.min(CONFIRM_CAP_MS, Math.max(75 * 60000, w / 4));
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
  const long = rateFrom(history.metricAnchors(providerId, metric.name, longLookbackMs(metric)));
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
  } else if (
    sustainable !== null &&
    short !== null &&
    long !== null &&
    short > sustainable &&
    long > sustainable
  ) {
    level = "crit";
  } else if (
    horizonHours !== null &&
    peakHeadroomHours !== null &&
    peakHeadroomHours < Math.min(horizonHours, PLANNING_HORIZON_H)
  ) {
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

export function computeSubscriptionRisk(
  sub: SubscriptionInfo | null | undefined,
  now: number
): SubscriptionRisk | null {
  if (!sub) return null;
  const hoursLeft = sub.endsAt ? (sub.endsAt - now) / H : null;
  let level: RiskLevel = "ok";
  if (sub.status && sub.status !== "VALID") level = "crit";
  // Only a confirmed "it will not renew" raises this. Unknown renewal used to
  // count as "will not renew", on the reasoning that an end date is real either
  // way — until a provider was found reporting a renewal flag that contradicted
  // its own billing system, and the monitor announced that a renewing plan was
  // about to lapse. A warning nobody can act on is worse than no warning, so an
  // unknown renewal now says nothing.
  else if (sub.autoRenew === false && hoursLeft !== null) {
    if (hoursLeft <= PLAN_EXPIRY_CRIT_H) level = "crit";
    else if (hoursLeft <= PLAN_EXPIRY_WARN_H) level = "warn";
  }
  return { level, endsAt: sub.endsAt, hoursLeft, autoRenew: sub.autoRenew, status: sub.status };
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
