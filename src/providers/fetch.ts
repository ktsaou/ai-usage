import type { ProviderConfig, ProviderResult, UsageMetric } from "../types.js";
import { resolveEnvVar } from "../config.js";
import { result, metric } from "./common.js";
import { fetchAlibabaCoding, fetchAlibabaToken } from "./alibaba.js";
import { fetchMimo } from "./mimo.js";

type FetchFn = (config: ProviderConfig) => Promise<ProviderResult>;

async function fetchZai(config: ProviderConfig): Promise<ProviderResult> {
  const key = resolveEnvVar(config.env.apiKey);
  if (!key) return result(config, [], null, "ZAI_API_KEY not set");

  const res = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
    headers: { Authorization: key, Accept: "application/json" },
  });
  if (!res.ok) return result(config, [], null, `HTTP ${res.status}`);

  const body = await res.json();
  if (!body.success) return result(config, [], null, body.msg || "API error");

  const metrics: UsageMetric[] = [];
  for (const limit of body.data.limits || []) {
    if (limit.type === "TOKENS_LIMIT" && (limit.unit === 3 || limit.unit === 6)) {
      // Token-plan buckets expose only a `percentage` (percent used), no raw counts.
      const window = limit.unit === 3 ? "5h" : "weekly";
      if (typeof limit.percentage === "number") {
        metrics.push(
          metric(`${window}_quota`, limit.percentage, 100, "%", window, limit.nextResetTime ?? null, {
            note: "model/LLM usage on the coding plan (prompt and completion tokens)",
          })
        );
      }
    } else if (limit.type === "TIME_LIMIT" && limit.unit === 5) {
      const mcpUsed = limit.currentValue ?? 0;
      const mcpTotal =
        limit.currentValue != null && limit.remaining != null
          ? limit.currentValue + limit.remaining
          : limit.usage ?? 0;
      // `usageDetails` names the tools consuming this quota (e.g. search-prime,
      // web-reader, zread), proving it counts hosted tool calls, not model usage.
      const breakdown: Record<string, number> = {};
      for (const d of limit.usageDetails || []) {
        if (d?.modelCode) breakdown[d.modelCode] = Number(d.usage) || 0;
      }
      metrics.push(
        metric("monthly_mcp", mcpUsed, mcpTotal, "tool calls", "monthly", limit.nextResetTime ?? null, {
          // Tool calls, not model usage: its percentage must never compete with
          // the coding-plan quotas for the card headline.
          secondary: true,
          note: "z.ai-hosted MCP tool calls (web search, web reader, zread) — NOT model/LLM requests or tokens",
          ...(Object.keys(breakdown).length > 0 ? { breakdown } : {}),
        })
      );
    }
  }
  return result(config, metrics, body.data.level || null);
}

async function fetchMinimax(config: ProviderConfig): Promise<ProviderResult> {
  const key = resolveEnvVar(config.env.subscriptionKey);
  const region = resolveEnvVar(config.env.region) || "intl";
  if (!key) return result(config, [], null, "MINIMAX_SUBSCRIPTION_KEY not set");

  const urls =
    region === "cn"
      ? ["https://api.minimaxi.com/v1/token_plan/remains", "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains"]
      : ["https://api.minimax.io/v1/api/openplatform/coding_plan/remains", "https://www.minimax.io/v1/token_plan/remains"];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
      });
      if (!res.ok) continue;
      const body = await res.json();
      if (body.base_resp?.status_code !== 0) continue;

      const metrics: UsageMetric[] = [];
      const models = body.model_remains || [];
      const active = models.find((m: any) => m.current_interval_status === 1) || models[0];
      if (active) {
        // International: usage_count = REMAINING (mislabeled). CN: usage_count = USED.
        // Reset times come from the window boundaries (end_time / weekly_end_time);
        // the *_remains_time fields are long-horizon countdowns, not the window reset.
        const intervalTotal = active.current_interval_total_count || 0;
        const intervalVal = active.current_interval_usage_count || 0;
        const intervalPct = active.current_interval_remaining_percent;
        const intervalResetAt = active.end_time ?? null;

        if (intervalTotal > 0) {
          const intervalUsed = region === "cn" ? intervalVal : intervalTotal - intervalVal;
          metrics.push(metric("5h_quota", intervalUsed, intervalTotal, "requests", "5h", intervalResetAt));
        } else if (active.current_interval_status === 1 && typeof intervalPct === "number") {
          // Token Plan: no fixed count, only percentage remaining
          metrics.push(metric("5h_quota", 100 - intervalPct, 100, "%", "5h", intervalResetAt));
        }

        // Weekly is unlimited on these plans (no count, status != active) -> skip it.
        const weeklyTotal = active.current_weekly_total_count || 0;
        const weeklyVal = active.current_weekly_usage_count || 0;
        const weeklyPct = active.current_weekly_remaining_percent;
        const weeklyResetAt = active.weekly_end_time ?? null;

        if (weeklyTotal > 0) {
          const weeklyUsed = region === "cn" ? weeklyVal : weeklyTotal - weeklyVal;
          metrics.push(metric("weekly_quota", weeklyUsed, weeklyTotal, "requests", "weekly", weeklyResetAt));
        } else if (active.current_weekly_status === 1 && typeof weeklyPct === "number") {
          metrics.push(metric("weekly_quota", 100 - weeklyPct, 100, "%", "weekly", weeklyResetAt));
        }
      }
      return result(config, metrics, null);
    } catch {
      continue;
    }
  }
  return result(config, [], null, "all endpoints failed");
}

async function fetchKimi(config: ProviderConfig): Promise<ProviderResult> {
  const key = resolveEnvVar(config.env.apiKey);
  if (!key) return result(config, [], null, "KIMI_CODING_API_KEY not set");

  const res = await fetch("https://api.kimi.com/coding/v1/usages", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) return result(config, [], null, `HTTP ${res.status}`);

  const body = await res.json();
  const metrics: UsageMetric[] = [];

  // Top-level `usage` is the weekly quota (its reset is days out); the `limits[]`
  // entries carry the explicit short windows (e.g. the 300-minute / 5h bucket).
  // Values are on a 0-100 percentage scale, not token/request counts.
  const usage = body.usage || body.data?.usage;
  if (usage) {
    const limit = Number(usage.limit) || 0;
    const used = Number(usage.used) || 0;
    const resetAt = usage.resetTime ? new Date(usage.resetTime).getTime() : (usage.reset_at ? new Date(usage.reset_at).getTime() : null);
    if (limit > 0) {
      metrics.push(metric("weekly_quota", used, limit, "%", "weekly", resetAt));
    }
  }

  const seen = new Set<string>();
  for (const entry of body.limits || body.data?.limits || []) {
    const detail = entry.detail || {};
    const limit = Number(detail.limit) || 0;
    const used = limit - (Number(detail.remaining) || 0);
    const dur = entry.window?.duration || 0;
    const unit = entry.window?.timeUnit || "";
    const windowMin = unit.includes("HOUR") ? dur * 60 : unit.includes("DAY") ? dur * 1440 : dur;
    const label = windowMin <= 360 ? `${windowMin / 60}h_quota` : `${windowMin / 1440}d_quota`;
    const resetAt = detail.resetTime ? new Date(detail.resetTime).getTime() : null;
    if (limit > 0 && !seen.has(label)) {
      seen.add(label);
      metrics.push(metric(label, used, limit, "%", label.replace("_quota", ""), resetAt));
    }
  }

  const plan = body.user?.membership?.level?.replace("LEVEL_", "").toLowerCase() || null;
  return result(config, metrics, plan);
}

async function fetchDeepseek(config: ProviderConfig): Promise<ProviderResult> {
  const key = resolveEnvVar(config.env.apiKey);
  if (!key) return result(config, [], null, "DEEPSEEK_API_KEY not set");

  const res = await fetch("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) return result(config, [], null, `HTTP ${res.status}`);

  const body = await res.json();
  const metrics: UsageMetric[] = [];
  for (const info of body.balance_infos || []) {
    const total = parseFloat(info.total_balance) || 0;
    const granted = parseFloat(info.granted_balance) || 0;
    const toppedUp = parseFloat(info.topped_up_balance) || 0;
    metrics.push(metric(`balance_${info.currency.toLowerCase()}`, null, total, info.currency, "lifetime", null));
    if (granted > 0) metrics.push(metric(`granted_${info.currency.toLowerCase()}`, null, granted, info.currency, "lifetime", null));
    if (toppedUp > 0) metrics.push(metric(`topped_up_${info.currency.toLowerCase()}`, null, toppedUp, info.currency, "lifetime", null));
  }
  return result(config, metrics, null);
}

async function fetchOpenrouter(config: ProviderConfig): Promise<ProviderResult> {
  const key = resolveEnvVar(config.env.apiKey);
  if (!key) return result(config, [], null, "OPENROUTER_API_KEY not set");

  const res = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) return result(config, [], null, `HTTP ${res.status}`);

  const body = await res.json();
  const metrics: UsageMetric[] = [];
  const total = body.data?.total_credits ?? body.total_credits ?? null;
  const used = body.data?.total_usage ?? body.total_usage ?? null;
  if (total !== null) {
    metrics.push(metric("credits", used, total, "USD", "lifetime", null));
  }
  return result(config, metrics, null);
}

// mimo and the alibaba plans have no usable API key; they poll through the
// shared logged-in browser session (see providers/browser.ts).
const registry: Record<string, FetchFn> = {
  zai: fetchZai,
  minimax: fetchMinimax,
  kimi: fetchKimi,
  mimo: fetchMimo,
  deepseek: fetchDeepseek,
  openrouter: fetchOpenrouter,
  "alibaba-coding": fetchAlibabaCoding,
  "alibaba-token": fetchAlibabaToken,
};

export async function fetchProvider(config: ProviderConfig): Promise<ProviderResult> {
  const fn = registry[config.type];
  if (!fn) {
    return result(config, [], null, `unknown provider type: ${config.type}`);
  }
  try {
    return await fn(config);
  } catch (err: any) {
    return result(config, [], null, err.message || "fetch failed");
  }
}
