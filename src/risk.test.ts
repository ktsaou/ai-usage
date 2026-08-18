import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeMetricRisk,
  computeProviderRisk,
  computeSubscriptionRisk,
  type RiskHistory,
} from "./risk.js";
import type { ProviderResult, UsageMetric } from "./types.js";

const H = 3600000;
const NOW = 1_760_000_000_000;

/**
 * A history that yields exactly the rates a case is about. The lookback tells
 * the short measurement from the confirming one, which is the whole point of
 * having two.
 */
function stubHistory(opts: {
  percent: number;
  short?: number | null;
  long?: number | null;
  peak?: number | null;
}): RiskHistory {
  return {
    metricAnchors(_p, _m, lookbackMs) {
      const rate = lookbackMs <= H ? opts.short : opts.long;
      if (rate === null || rate === undefined) return null;
      return {
        last: { t: NOW, v: opts.percent },
        base: { t: NOW - lookbackMs, v: opts.percent - rate * (lookbackMs / H) },
      };
    },
    peakHourlyRise: () => opts.peak ?? null,
  };
}

function quota(percent: number, extra: Partial<UsageMetric> = {}): UsageMetric {
  return {
    name: "weekly_quota",
    used: percent,
    total: 100,
    remaining: 100 - percent,
    percent,
    unit: "%",
    window: "weekly",
    resetsAt: NOW + 100 * H,
    ...extra,
  };
}

test("a pace that finishes before the reset is ok", () => {
  const m = quota(30, { window: "5h", resetsAt: NOW + 4 * H });
  const r = computeMetricRisk(stubHistory({ percent: 30, short: 5, long: 5, peak: 5 }), "p", m, NOW)!;
  assert.equal(r.level, "ok");
  assert.equal(r.headroomHours, 14); // 70% left at 5%/h
  assert.ok(r.burnRatio! < 1);
});

test("a pace that beats the reset is critical, and states when it runs out", () => {
  const m = quota(40, { window: "5h", resetsAt: NOW + 4 * H });
  const r = computeMetricRisk(stubHistory({ percent: 40, short: 20, long: 20, peak: 20 }), "p", m, NOW)!;
  assert.equal(r.level, "crit");
  assert.equal(r.headroomHours, 3); // 60% left at 20%/h, against a 4h horizon
  assert.ok(r.burnRatio! > 1);
});

test("a single busy hour does not trip critical without the longer lookback agreeing", () => {
  const m = quota(30, { window: "5h", resetsAt: NOW + 4 * H });
  const r = computeMetricRisk(stubHistory({ percent: 30, short: 40, long: 1, peak: 0 }), "p", m, NOW)!;
  assert.equal(r.level, "ok");
});

test("idle, but the worst recent hour would end it — elevated, with what a resumed burst costs", () => {
  const m = quota(60);
  const r = computeMetricRisk(stubHistory({ percent: 60, short: 0, long: 0, peak: 20 }), "p", m, NOW)!;
  assert.equal(r.level, "warn");
  assert.equal(r.headroomHours, null); // nothing is burning right now
  assert.equal(r.peakHeadroomHours, 2);
});

test("a busy hour projected across a monthly window does not raise an alarm", () => {
  const m = quota(20, { window: "monthly", resetsAt: NOW + 500 * H });
  const r = computeMetricRisk(stubHistory({ percent: 20, short: 0, long: 0, peak: 1 }), "p", m, NOW)!;
  assert.equal(r.level, "ok"); // 80h of headroom is beyond any planning horizon
});

test("a rolling window is judged against its own length, not a reset", () => {
  const m = quota(50, { window: "5h", resetsAt: null, rolling: true });
  const r = computeMetricRisk(stubHistory({ percent: 50, short: 20, long: 20, peak: 20 }), "p", m, NOW)!;
  assert.equal(r.rolling, true);
  assert.equal(r.horizonHours, 5);
  assert.equal(r.burnRatio, 2); // 50% left, 10%/h affordable, 20%/h actual
  assert.equal(r.level, "crit");
});

test("with no history the level still reflects how full the quota is", () => {
  const empty: RiskHistory = { metricAnchors: () => null, peakHourlyRise: () => null };
  const r = computeMetricRisk(empty, "p", quota(95), NOW)!;
  assert.equal(r.level, "crit");
  assert.equal(r.ratePerHour, null);
  assert.equal(r.burnRatio, null);
});

test("a quota that is nearly full is never reported as ok just because it is idle", () => {
  const r = computeMetricRisk(stubHistory({ percent: 75, short: 0, long: 0, peak: 0 }), "p", quota(75), NOW)!;
  assert.equal(r.level, "warn");
});

test("an exhausted quota is critical", () => {
  const r = computeMetricRisk(stubHistory({ percent: 100, short: 0, long: 0, peak: 0 }), "p", quota(100), NOW)!;
  assert.equal(r.level, "crit");
});

test("a metric without a percentage carries no risk", () => {
  const balance: UsageMetric = {
    name: "balance",
    used: null,
    total: 42,
    remaining: null,
    percent: null,
    unit: "USD",
    window: null,
    resetsAt: null,
  };
  assert.equal(computeMetricRisk(stubHistory({ percent: 0 }), "p", balance, NOW), null);
});

function providerResult(metrics: UsageMetric[]): ProviderResult {
  return {
    providerId: "p",
    providerType: "p",
    name: "P",
    plan: null,
    metrics,
    fetchedAt: NOW,
    error: null,
  };
}

/** Per-metric rates, for providers whose windows are being consumed differently. */
function stubPerMetric(byMetric: Record<string, Parameters<typeof stubHistory>[0]>): RiskHistory {
  return {
    metricAnchors: (p, m, lookbackMs) => stubHistory(byMetric[m]).metricAnchors(p, m, lookbackMs),
    peakHourlyRise: (p, m, since) => stubHistory(byMetric[m]).peakHourlyRise(p, m, since),
  };
}

test("a provider is judged by the window in the worst state", () => {
  const history = stubPerMetric({
    weekly_quota: { percent: 20, short: 0.5, long: 0.5, peak: 0.5 },
    "5h_quota": { percent: 40, short: 20, long: 20, peak: 20 },
  });
  const result = providerResult([
    quota(20, { name: "weekly_quota", window: "weekly", resetsAt: NOW + 100 * H }),
    quota(40, { name: "5h_quota", window: "5h", resetsAt: NOW + 4 * H }),
  ]);
  const risk = computeProviderRisk(history, result, NOW)!;
  assert.equal(risk.metric, "5h_quota");
  assert.equal(risk.level, "crit");
  assert.equal(risk.binding!.headroomHours, 3);
  assert.equal(Object.keys(risk.metrics).length, 2); // both still reported
});

test("between equally healthy windows, the one with less headroom is reported", () => {
  const history = stubPerMetric({
    weekly_quota: { percent: 20, short: 0.5, long: 0.5, peak: 0.5 },
    "5h_quota": { percent: 20, short: 5, long: 5, peak: 5 },
  });
  const result = providerResult([
    quota(20, { name: "weekly_quota", window: "weekly", resetsAt: NOW + 100 * H }),
    quota(20, { name: "5h_quota", window: "5h", resetsAt: NOW + 4 * H }),
  ]);
  const risk = computeProviderRisk(history, result, NOW)!;
  assert.equal(risk.level, "ok");
  assert.equal(risk.metric, "5h_quota");
  assert.equal(risk.binding!.headroomHours, 16);
});

test("a secondary quota never speaks for the provider, but keeps its own risk", () => {
  const history = stubHistory({ percent: 95, short: 0, long: 0, peak: 0 });
  const result = providerResult([
    quota(95, { name: "monthly_mcp", window: "monthly", secondary: true }),
    quota(10, { name: "5h_quota", window: "5h", resetsAt: NOW + 4 * H }),
  ]);
  const risk = computeProviderRisk(history, result, NOW)!;
  assert.equal(risk.metric, "5h_quota");
  assert.equal(risk.level, "ok");
  assert.equal(risk.metrics.monthly_mcp.level, "crit");
});

test("a spent window that another pool covers stops speaking for the provider", () => {
  const history = stubPerMetric({
    weekly_quota: { percent: 100, short: 0, long: 0, peak: 0 },
    addon_credits: { percent: 0, short: 0, long: 0, peak: 0 },
  });
  const result = providerResult([
    quota(100, { name: "weekly_quota", window: "weekly", backstopped: true }),
    quota(0, { name: "addon_credits", window: null, resetsAt: null, expiresAt: NOW + 700 * H }),
  ]);
  const risk = computeProviderRisk(history, result, NOW)!;
  assert.equal(risk.metric, "addon_credits");
  assert.equal(risk.level, "ok");
  // ...while still reporting the truth about the window itself
  assert.equal(risk.metrics.weekly_quota.level, "crit");
});

test("without the backstop the same spent window is the provider's problem", () => {
  const history = stubPerMetric({ weekly_quota: { percent: 100, short: 0, long: 0, peak: 0 } });
  const result = providerResult([quota(100, { name: "weekly_quota", window: "weekly" })]);
  assert.equal(computeProviderRisk(history, result, NOW)!.level, "crit");
});

test("a plan ending soon without auto-renewal outranks healthy quotas", () => {
  const history = stubPerMetric({ weekly_quota: { percent: 10, short: 0, long: 0, peak: 0 } });
  const result: ProviderResult = {
    ...providerResult([quota(10, { name: "weekly_quota", window: "weekly" })]),
    subscription: { endsAt: NOW + 30 * H, remainingDays: 1, autoRenew: false, status: "VALID" },
  };
  const risk = computeProviderRisk(history, result, NOW)!;
  assert.equal(risk.level, "crit");
  assert.equal(risk.binding!.level, "ok"); // the quota itself is fine
  assert.equal(risk.subscription!.level, "crit");
});

test("plan expiry levels follow the deadline, and auto-renewal clears them", () => {
  const at = (h: number, autoRenew: boolean | null) =>
    computeSubscriptionRisk({ endsAt: NOW + h * H, remainingDays: null, autoRenew, status: "VALID" }, NOW)!
      .level;
  assert.equal(at(30, false), "crit"); // inside 48h
  assert.equal(at(72, false), "warn"); // inside a week
  assert.equal(at(300, false), "ok");
  assert.equal(at(30, true), "ok"); // it renews itself; the date is bookkeeping
  // Unknown renewal says nothing. A vendor was found reporting a renewal flag
  // that contradicted its own billing system, and treating unknown as "will not
  // renew" announced that a renewing plan was about to lapse.
  assert.equal(at(30, null), "ok");
});

test("a plan the provider itself calls invalid is critical whatever the dates say", () => {
  const r = computeSubscriptionRisk(
    { endsAt: NOW + 900 * H, remainingDays: 37, autoRenew: true, status: "EXPIRED" },
    NOW
  )!;
  assert.equal(r.level, "crit");
});

test("no subscription information yields none, not a reassuring default", () => {
  assert.equal(computeSubscriptionRisk(null, NOW), null);
  const history = stubPerMetric({ weekly_quota: { percent: 10, short: 0, long: 0, peak: 0 } });
  const risk = computeProviderRisk(history, providerResult([quota(10, { name: "weekly_quota" })]), NOW)!;
  assert.equal(risk.subscription, null);
});

test("a failed poll produces no risk at all, rather than a reassuring one", () => {
  const result = { ...providerResult([quota(10)]), error: "boom" };
  assert.equal(computeProviderRisk(stubHistory({ percent: 10 }), result, NOW), null);
});

test("a pool covering a spent window is judged against that window's reset", () => {
  // The packs exist to bridge the gap: 57% of them left, burning 2.3%/h, and the
  // spent window resets in 52h. That is 25h of cover for a 52h gap.
  const history = stubPerMetric({
    weekly_quota: { percent: 100, short: 0, long: 0, peak: 0 },
    addon_credits: { percent: 43, short: 2.3, long: 2.3, peak: 2.3 },
  });
  const result = providerResult([
    quota(100, { name: "weekly_quota", window: "weekly", backstopped: true, resetsAt: NOW + 52 * H }),
    quota(43, {
      name: "addon_credits",
      window: null,
      resetsAt: null,
      expiresAt: NOW + 700 * H,
      coversUntil: NOW + 52 * H,
    }),
  ]);
  const risk = computeProviderRisk(history, result, NOW)!;
  const addon = risk.metrics.addon_credits;
  assert.equal(addon.bridging, true);
  assert.equal(Math.round(addon.horizonHours!), 52);
  assert.ok(addon.headroomHours! < addon.horizonHours!, "runs out before the window resets");
  assert.ok(addon.burnRatio! > 1);
  assert.equal(addon.level, "crit");
  assert.equal(risk.level, "crit"); // and it is the provider's binding constraint
  assert.equal(risk.metric, "addon_credits");
});

test("the same pool is fine when it comfortably outlasts the gap", () => {
  const history = stubPerMetric({
    weekly_quota: { percent: 100, short: 0, long: 0, peak: 0 },
    addon_credits: { percent: 10, short: 0.5, long: 0.5, peak: 0.5 },
  });
  const result = providerResult([
    quota(100, { name: "weekly_quota", window: "weekly", backstopped: true, resetsAt: NOW + 20 * H }),
    quota(10, { name: "addon_credits", window: null, resetsAt: null, coversUntil: NOW + 20 * H }),
  ]);
  const risk = computeProviderRisk(history, result, NOW)!;
  assert.equal(risk.metrics.addon_credits.level, "ok"); // 180h of cover for a 20h gap
  assert.equal(risk.level, "ok");
});

test("with no window to cover, a pool has no deadline and says so", () => {
  const history = stubPerMetric({ addon_credits: { percent: 10, short: 0.5, long: 0.5, peak: 0.5 } });
  const result = providerResult([
    quota(10, { name: "addon_credits", window: null, resetsAt: null, coversUntil: null }),
  ]);
  const addon = computeProviderRisk(history, result, NOW)!.metrics.addon_credits;
  assert.equal(addon.bridging, false);
  assert.equal(addon.horizonHours, null);
  assert.equal(addon.burnRatio, null);
});

test("nearly full, but comfortably reaching its reset, is not elevated", () => {
  // The kimi case: 84% used looks alarming and is not. 16% left at 1%/h is 16h
  // of headroom against a reset 4.6h away, and even its worst recent hour makes
  // it. Fullness must not override a pace that plainly arrives.
  const m = quota(84, { window: "weekly", resetsAt: NOW + 4.6 * H });
  const r = computeMetricRisk(stubHistory({ percent: 84, short: 1, long: 1, peak: 3 }), "p", m, NOW)!;
  assert.equal(Math.round(r.headroomHours!), 16);
  assert.ok(r.burnRatio! < 1);
  assert.equal(r.level, "ok");
});

test("fullness still decides when there is no pace to judge by", () => {
  const idle = stubHistory({ percent: 84, short: 0, long: 0, peak: 0 });
  const m = quota(84, { window: "weekly", resetsAt: NOW + 4.6 * H });
  assert.equal(computeMetricRisk(idle, "p", m, NOW)!.level, "warn");
});

test("a two-hour overshoot confirms critical without waiting for a six-hour average", () => {
  // Measured on the live add-on pool: 1h 3.9%/h, 2h 2.0%/h, 6h 0.95%/h, against
  // 1.05%/h affordable. The six-hour average lagged behind a burst that had been
  // over budget for hours.
  const m = quota(45, { window: null, resetsAt: null, coversUntil: NOW + 52 * H });
  const r = computeMetricRisk(stubHistory({ percent: 45, short: 3.9, long: 2.0, peak: 10 }), "p", m, NOW)!;
  assert.ok(r.burnRatio! > 1);
  assert.equal(r.level, "crit");
});
