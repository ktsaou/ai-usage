import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessToken, LOGIN_REQUIRED, readAuth, writeAuth, xaiMetrics, xaiPlan, type XaiAuth } from "./providers/xai.js";
import { computeProviderRisk, type RiskHistory } from "./risk.js";
import type { ProviderResult, UsageMetric } from "./types.js";

const NOW = 1_760_000_000_000;
const H = 3600000;
const END = "2026-09-09T14:20:35.797497+00:00";
const END_MS = Date.parse(END);

/** The credits reply as the proxy sends it for a fresh week: the zero percent is omitted. */
function credits(extra: Record<string, unknown> = {}) {
  return {
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-02T14:20:35.797497+00:00", end: END },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      isUnifiedBillingUser: true,
      prepaidBalance: { val: 0 },
      topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
      ...extra,
    },
  };
}

test("a fresh week reads as 0% used with the period end as its reset", () => {
  const [weekly, ...rest] = xaiMetrics(credits());
  assert.equal(weekly.name, "weekly_quota");
  assert.equal(weekly.percent, 0);
  assert.equal(weekly.remaining, 100);
  assert.equal(weekly.window, "weekly");
  assert.equal(weekly.resetsAt, END_MS);
  assert.equal(weekly.backstopped, undefined);
  assert.deepEqual(rest, []); // an empty reserve is not a metric
});

test("the floored percent is taken as is", () => {
  const [weekly] = xaiMetrics(credits({ creditUsagePercent: 37 }));
  assert.equal(weekly.used, 37);
  assert.equal(weekly.percent, 37);
});

test("prepaid credits nobody draws on are a secondary dollar balance", () => {
  const metrics = xaiMetrics(credits({ creditUsagePercent: 40, prepaidBalance: { val: -1250 } }));
  const pool = metrics.find((m) => m.name === "prepaid_credits")!;
  assert.equal(pool.total, 12.5); // negative cents are a balance, not a debt
  assert.equal(pool.used, null);
  assert.equal(pool.percent, null); // no denominator: never judged by pace
  assert.equal(pool.unit, "USD");
  assert.equal(pool.secondary, true);
  assert.equal(pool.coversUntil, null);
  assert.equal(metrics[0].backstopped, undefined);
});

test("a spent week with credits left is backstopped, and the credits must last until its reset", () => {
  const metrics = xaiMetrics(credits({ creditUsagePercent: 100, prepaidBalance: { val: -500 } }));
  const [weekly, pool] = metrics;
  assert.equal(weekly.backstopped, true);
  assert.equal(pool.secondary, undefined);
  assert.equal(pool.coversUntil, END_MS);
});

test("a spent week with no credits stays the binding window", () => {
  const metrics = xaiMetrics(credits({ creditUsagePercent: 100 }));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].backstopped, undefined);
});

test("the older extra-usage mode is not emitted", () => {
  const metrics = xaiMetrics(credits({ isUnifiedBillingUser: false, onDemandCap: { val: 10000 }, onDemandUsed: { val: 250 } }));
  assert.deepEqual(
    metrics.map((m) => m.name),
    ["weekly_quota"]
  );
});

test("a reply without a weekly period is an error, not a guess", () => {
  assert.throws(() => xaiMetrics({}), /no config/);
  assert.throws(() => xaiMetrics({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: END } } }), /no weekly period \(USAGE_PERIOD_TYPE_MONTHLY\)/);
  assert.throws(() => xaiMetrics(credits({ creditUsagePercent: "lots" })), /creditUsagePercent/);
});

test("the plan is the settings tier label", () => {
  assert.equal(xaiPlan({ subscription_tier_display: " SuperGrok Plus " }), "SuperGrok Plus");
  assert.equal(xaiPlan({ subscription_tier_display: "" }), null);
  assert.equal(xaiPlan(null), null);
});

function stubHistory(rates: Record<string, { percent: number; rate: number }>): RiskHistory {
  return {
    metricAnchors: (_p, name) => {
      const r = rates[name];
      if (!r) return null;
      return { last: { t: NOW, v: r.percent }, base: { t: NOW - H, v: r.percent - r.rate } };
    },
    peakHourlyRise: (_p, name) => rates[name]?.rate ?? null,
  };
}

function providerResult(metrics: UsageMetric[]): ProviderResult {
  return { providerId: "xai", providerType: "xai", name: "xAI", plan: null, metrics, fetchedAt: NOW, error: null };
}

test("the weekly window speaks for the provider, and the reserve never does", () => {
  const history = stubHistory({ weekly_quota: { percent: 40, rate: 1 } });
  const risk = computeProviderRisk(history, providerResult(xaiMetrics(credits({ creditUsagePercent: 40, prepaidBalance: { val: -1250 } }))), NOW)!;
  assert.equal(risk.metric, "weekly_quota");
  assert.equal(risk.metrics.prepaid_credits, undefined);
});

test("a week spent onto the credits is not reported at risk", () => {
  // With the allowance at 100% the provider is still serving from the credits;
  // the spent window keeps its own crit but does not speak for the provider.
  const history = stubHistory({ weekly_quota: { percent: 100, rate: 5 } });
  const risk = computeProviderRisk(history, providerResult(xaiMetrics(credits({ creditUsagePercent: 100, prepaidBalance: { val: -500 } }))), NOW)!;
  assert.equal(risk.level, "ok");
  assert.equal(risk.metric, null);
  assert.equal(risk.metrics.weekly_quota.level, "crit");
});

// --- the credential file and its refresh ---

const dir = mkdtempSync(join(tmpdir(), "ai-usage-xai-"));
const fresh = (over: Partial<XaiAuth> = {}): XaiAuth => ({
  access_token: "access-old",
  refresh_token: "refresh-old",
  expires_at: NOW + 3 * H,
  token_endpoint: "https://auth.x.ai/oauth2/token",
  ...over,
});

function fetchStub(replies: Array<{ status: number; body: unknown }>, calls: Array<{ url: string; form: string }>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), form: String(init?.body) });
    const reply = replies.shift() ?? { status: 500, body: null };
    await new Promise((r) => setTimeout(r, 5)); // long enough for a second caller to arrive
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
}

test("the file is private, and read back as written", () => {
  const path = join(dir, "written.json");
  writeAuth(path, fresh());
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readAuth(path), fresh());
});

test("a valid token is returned without touching the network", async () => {
  const path = join(dir, "valid.json");
  writeAuth(path, fresh());
  const calls: Array<{ url: string; form: string }> = [];
  assert.equal(await accessToken(path, { fetch: fetchStub([], calls), now: () => NOW }), "access-old");
  assert.equal(calls.length, 0);
});

test("a token about to expire is refreshed once, and the rotated pair is persisted", async () => {
  const path = join(dir, "expiring.json");
  writeAuth(path, fresh({ expires_at: NOW + 2 * 60000 }));
  const calls: Array<{ url: string; form: string }> = [];
  const deps = {
    fetch: fetchStub([{ status: 200, body: { access_token: "access-new", refresh_token: "refresh-new", expires_in: 21600 } }], calls),
    now: () => NOW,
  };
  // Two polls racing for the same file must share one refresh: the refresh
  // token is single-use, and a second exchange would log the daemon out.
  const [a, b] = await Promise.all([accessToken(path, deps), accessToken(path, deps)]);
  assert.equal(a, "access-new");
  assert.equal(b, "access-new");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://auth.x.ai/oauth2/token");
  assert.match(calls[0].form, /grant_type=refresh_token/);
  assert.match(calls[0].form, /refresh_token=refresh-old/);
  const saved = JSON.parse(readFileSync(path, "utf-8"));
  assert.equal(saved.refresh_token, "refresh-new");
  assert.equal(saved.expires_at, NOW + 21600 * 1000);
});

test("a revoked refresh token asks for a new login", async () => {
  const path = join(dir, "revoked.json");
  writeAuth(path, fresh({ expires_at: NOW - 1 }));
  const deps = { fetch: fetchStub([{ status: 400, body: { error: "invalid_grant" } }], []), now: () => NOW };
  await assert.rejects(accessToken(path, deps), new RegExp(LOGIN_REQUIRED.slice(0, 14)));
  assert.equal(readAuth(path)!.refresh_token, "refresh-old"); // nothing overwritten on failure
});

test("no file at all asks for a login", async () => {
  await assert.rejects(accessToken(join(dir, "missing.json"), { fetch: fetchStub([], []), now: () => NOW }), /login required/);
});
