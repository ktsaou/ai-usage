import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetricRisk, computeProviderRisk, type RiskHistory } from "./risk.js";
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

test("a failed poll produces no risk at all, rather than a reassuring one", () => {
  const result = { ...providerResult([quota(10)]), error: "boom" };
  assert.equal(computeProviderRisk(stubHistory({ percent: 10 }), result, NOW), null);
});
