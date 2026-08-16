import { DB } from "./db.js";
import type { ProviderRisk, RiskLevel } from "./risk.js";

const LEVEL_VALUE: Record<RiskLevel, number> = { ok: 0, warn: 1, crit: 2 };

/**
 * Prometheus text format. `+Inf` is a valid gauge value and is used where a
 * quota is not being consumed at all: dropping the series instead would make
 * every alert expression fall through the gap exactly when nothing is wrong.
 */
export function renderMetrics(db: DB, riskFor?: (providerId: string) => ProviderRisk | undefined): string {
  const rows = db.allLatest();
  const lines: string[] = [];

  lines.push("# HELP ai_usage_percent Usage percentage (0-100)");
  lines.push("# TYPE ai_usage_percent gauge");
  lines.push("# HELP ai_usage_used Used amount");
  lines.push("# TYPE ai_usage_used gauge");
  lines.push("# HELP ai_usage_total Total allowance");
  lines.push("# TYPE ai_usage_total gauge");
  lines.push("# HELP ai_usage_remaining Remaining allowance");
  lines.push("# TYPE ai_usage_remaining gauge");
  lines.push("# HELP ai_usage_burn_rate_percent_per_hour Percent of the quota consumed per hour, over the last hour");
  lines.push("# TYPE ai_usage_burn_rate_percent_per_hour gauge");
  lines.push(
    "# HELP ai_usage_peak_burn_rate_percent_per_hour Percent of the quota consumed in the busiest hour of the last 24"
  );
  lines.push("# TYPE ai_usage_peak_burn_rate_percent_per_hour gauge");
  lines.push("# HELP ai_usage_burn_ratio Current burn rate over the rate this quota can afford until it resets (>1 exhausts early)");
  lines.push("# TYPE ai_usage_burn_ratio gauge");
  lines.push("# HELP ai_usage_headroom_hours Hours until this quota is exhausted at the current burn rate");
  lines.push("# TYPE ai_usage_headroom_hours gauge");
  lines.push("# HELP ai_usage_risk_level Exhaustion risk: 0 ok, 1 elevated, 2 at risk");
  lines.push("# TYPE ai_usage_risk_level gauge");
  lines.push("# HELP ai_usage_plan_seconds_remaining Seconds until the subscription itself ends");
  lines.push("# TYPE ai_usage_plan_seconds_remaining gauge");
  lines.push("# HELP ai_usage_plan_auto_renew Whether the subscription renews itself: 1 yes, 0 no");
  lines.push("# TYPE ai_usage_plan_auto_renew gauge");

  for (const row of rows) {
    const labels = `provider="${row.provider_id}",name="${row.provider_name}",metric="${row.metric_name}",unit="${row.unit}",window="${row.window || ""}"`;

    if (row.percent !== null) {
      lines.push(`ai_usage_percent{${labels}} ${row.percent}`);
    }
    if (row.used !== null) {
      lines.push(`ai_usage_used{${labels}} ${row.used}`);
    }
    if (row.total !== null) {
      lines.push(`ai_usage_total{${labels}} ${row.total}`);
    }
    if (row.remaining !== null) {
      lines.push(`ai_usage_remaining{${labels}} ${row.remaining}`);
    }

    const risk = riskFor?.(row.provider_id)?.metrics[row.metric_name];
    if (!risk) continue;
    if (risk.ratePerHour !== null) {
      lines.push(`ai_usage_burn_rate_percent_per_hour{${labels}} ${risk.ratePerHour}`);
      lines.push(`ai_usage_headroom_hours{${labels}} ${risk.headroomHours ?? "+Inf"}`);
    }
    if (risk.peakRatePerHour !== null) {
      lines.push(`ai_usage_peak_burn_rate_percent_per_hour{${labels}} ${risk.peakRatePerHour}`);
    }
    if (risk.burnRatio !== null) {
      lines.push(`ai_usage_burn_ratio{${labels}} ${risk.burnRatio}`);
    }
    lines.push(`ai_usage_risk_level{${labels}} ${LEVEL_VALUE[risk.level]}`);
  }

  // Plan-level, once per provider: a subscription that ends without renewing
  // takes every quota on it with it, however healthy those look.
  const now = Date.now();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.provider_id)) continue;
    seen.add(row.provider_id);
    const sub = riskFor?.(row.provider_id)?.subscription;
    if (!sub) continue;
    const labels = `provider="${row.provider_id}",name="${row.provider_name}"`;
    if (sub.endsAt !== null) {
      lines.push(`ai_usage_plan_seconds_remaining{${labels}} ${Math.round((sub.endsAt - now) / 1000)}`);
    }
    if (sub.autoRenew !== null) {
      lines.push(`ai_usage_plan_auto_renew{${labels}} ${sub.autoRenew ? 1 : 0}`);
    }
  }

  return lines.join("\n") + "\n";
}
