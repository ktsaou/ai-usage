import { test } from "node:test";
import assert from "node:assert/strict";
import { addonPoolMetric } from "./providers/alibaba.js";
import { computeProviderRisk, type RiskHistory } from "./risk.js";
import type { ProviderResult, UsageMetric } from "./types.js";

const H = 3600000;
const NOW = 1_760_000_000_000;

/** A plan window as the Alibaba token fetcher emits it. */
function planWindow(percent: number, extra: Partial<UsageMetric> = {}): UsageMetric {
  return {
    name: "weekly_quota",
    used: percent,
    total: 100,
    remaining: 100 - percent,
    percent,
    unit: "%",
    window: "weekly",
    resetsAt: NOW + 50 * H,
    ...extra,
  };
}

const POOL = { totalCredits: 100000, remainingCredits: 40000, activeCount: 5, nearestExpireTime: NOW + 400 * H };

test("an exhausted pack pool is not reported at all", () => {
  // The state that made a working plan read `at risk`: the pool is spent, the
  // window it used to cover has reset, and the plan is paying again.
  assert.equal(addonPoolMetric({ ...POOL, remainingCredits: 0 }, [planWindow(3)]), null);
});

test("a pack pool is not reported when the vendor sends no usable figures", () => {
  assert.equal(addonPoolMetric(null, []), null);
  assert.equal(addonPoolMetric({ totalCredits: 0, remainingCredits: 0 }, []), null);
  assert.equal(addonPoolMetric({ totalCredits: 100000 }, []), null); // remaining absent
});

test("a pack pool covering nothing is reported, but never speaks for the provider", () => {
  const pool = addonPoolMetric(POOL, [planWindow(3)])!;
  assert.equal(pool.percent, 60);
  assert.equal(pool.secondary, true);
  assert.equal(pool.coversUntil, null); // no deadline: nothing is drawing on it
  assert.equal(pool.expiresAt, NOW + 400 * H);
  assert.match(pool.note!, /5 active/);
});

test("a pack pool covering a spent window binds, and inherits that window's reset", () => {
  const pool = addonPoolMetric(POOL, [
    planWindow(100, { name: "5h_quota", window: "5h", backstopped: true, resetsAt: NOW + 2 * H }),
    planWindow(100, { backstopped: true, resetsAt: NOW + 50 * H }),
  ])!;
  assert.equal(pool.secondary, undefined); // eligible: it is the thing paying
  assert.equal(pool.coversUntil, NOW + 2 * H); // the soonest covered window
});

/** Rates for whichever metric is asked about, so a case states its own pace. */
function stubHistory(byMetric: Record<string, { percent: number; rate: number }>): RiskHistory {
  return {
    metricAnchors: (_p, m, lookbackMs) => {
      const o = byMetric[m];
      if (!o) return null;
      return {
        last: { t: NOW, v: o.percent },
        base: { t: NOW - lookbackMs, v: o.percent - o.rate * (lookbackMs / H) },
      };
    },
    peakHourlyRise: (_p, m) => byMetric[m]?.rate ?? null,
  };
}

function providerResult(metrics: UsageMetric[]): ProviderResult {
  return {
    providerId: "alibaba-token",
    providerType: "alibaba-token",
    name: "token plan",
    plan: "pro",
    metrics,
    fetchedAt: NOW,
    error: null,
  };
}

test("a spent reserve leaves the plan window speaking for the provider", () => {
  // The reported defect, end to end: with the pool emitted at 100% the provider
  // was `crit` on `addon_credits` while its only plan window sat at 3% used.
  const history = stubHistory({ weekly_quota: { percent: 3, rate: 0.2 } });
  const metrics: UsageMetric[] = [planWindow(3)];
  const pool = addonPoolMetric({ ...POOL, remainingCredits: 0 }, metrics);
  if (pool) metrics.push(pool);

  const risk = computeProviderRisk(history, providerResult(metrics), NOW)!;
  assert.equal(risk.metric, "weekly_quota");
  assert.equal(risk.level, "ok");
  assert.equal(risk.metrics.addon_credits, undefined);
});

test("a held reserve cannot make a healthy provider look elevated", () => {
  // A pool with no deadline is not judgeable, so it falls back to its fill
  // level. At 95% spent that is `crit` — which says nothing about the plan,
  // because nothing is drawing on the pool.
  const history = stubHistory({ weekly_quota: { percent: 3, rate: 0.2 } });
  const metrics: UsageMetric[] = [planWindow(3)];
  metrics.push(addonPoolMetric({ ...POOL, remainingCredits: 5000 }, metrics)!);

  const risk = computeProviderRisk(history, providerResult(metrics), NOW)!;
  assert.equal(risk.metric, "weekly_quota");
  assert.equal(risk.level, "ok");
  assert.equal(risk.metrics.addon_credits.level, "crit"); // its own reading, kept
});
